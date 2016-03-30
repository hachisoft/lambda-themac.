var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment-timezone');

var config = require('./config.js');
var util = require('util');

//var S3 = require('./co-s3.js');

//var s3 = new S3();

var s3 = new aws.S3();
var SNS = new aws.SNS();

var nodemailer = require('nodemailer');
var ses = require('nodemailer-ses-transport');


var transporter = nodemailer.createTransport(ses({
    region: 'us-west-2',
    rateLimit: 20
}));

if (config.verbose) {
    console.log('started notify.js');
}

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    if (config.verbose) {
        console.error(err.stack);
    }
}

exports.handler = function (params, context) {
    var stage = params.stage || 'dev';
    var result = '';
    if (params) {
        // Read options from the params.
        if (config.verbose) {
            console.log("Reading options from params:\n", util.inspect(params, { depth: 5 }));
        }
        
        var fromAddress = null;
        var firebaseUrl = null;
        var authToken = null;
        var templateBucket = '';
        var notifyUsersARN = null;
        var linkRoot = null;
        if (stage === 'v0') {
            templateBucket = config.prodTemplateBucket;
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
            fromAddress = config.prodFromAddress;
            notifyUsersARN = config.prodNotifyUsersARN;
            linkRoot = config.prodLinkRoot;
        }
        else if (stage === 'v0_2') {
            templateBucket = config.prod2TemplateBucket;
            authToken = config.prod2Secret;
            firebaseUrl = config.prod2FirebaseUrl;
            fromAddress = config.prodFromAddress;
            notifyUsersARN = config.prod2NotifyUsersARN;
            linkRoot = config.prod2LinkRoot;
        }
        else {
            templateBucket = config.devTemplateBucket;
            authToken = config.devSecret;
            firebaseUrl = config.devFirebaseUrl;
            fromAddress = config.fromAddress;
            notifyUsersARN = config.devNotifyUsersARN;
            linkRoot = config.devLinkRoot;
        }
        
        console.log(config);
        
        var templateName = "notification.html";
        if (params.type === "notifyPromotion" && params.eventDetails) {
            if (params.eventDetails.length == 1) {
                templateName = "promotion1.html";
            }
            else if (params.eventDetails.length == 2) {
                templateName = "promotion2.html";
            }
            else if (params.eventDetails.length == 3) {
                templateName = "promotion3.html";
            }
            else if (params.eventDetails.length == 4) {
                templateName = "promotion4.html";
            }
        }
        else if (params.type === 'eventCreate') {
            templateName = 'event_creation_confirmation.html';
        }

        NodeFire.setCacheSize(10);
        NodeFire.DEBUG = true;
        var db = new NodeFire(firebaseUrl);
        db.auth(authToken).then(function () {
            if (config.verbose) {
                console.log('Auth succeeded');
                console.log({'templateBucket':templateBucket,'templateName':templateName});
            }
            params.interests = [];
            co(function*() {
                if (params.provisioned) {
                    var _sendingUser = db.child("users/" + params.provisioned);
                    var sendingUser = yield _sendingUser.get();
                    if (sendingUser) {
                        params.admin = sendingUser.memberNumber;
                        params.adminName = sendingUser.firstName + ' ' + sendingUser.lastName;
                    }
                }
                if (params.type === 'interest') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        yield processInterestNotification(db, params.id, fromAddress, params, templateBody);
                    }
                }
                else if (params.type === 'event') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        yield processEventNotification(db, params.id, fromAddress, params, templateBody);
                    }
                }
                else if (params.type === 'user') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        params.subject = params.title;
                        yield processUserNotification(db, params.id, fromAddress, params, templateBody);
                    }
                }
                else if (params.type === 'closure') {
                    yield processClosureNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName);
                }
                else if (params.type === 'emergency') {
                    yield processEmergencyNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName);
                }
                else if (params.type === 'feedback') {
                    yield processFeedbackNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, null);
                }
                else if (params.type === 'eventCreate') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        yield processEventCreateNotification(db, params.id, fromAddress, templateBody);
                    }
                }
                else if (params.type === 'childcare') {
                    yield processChildcareNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, null);
                }
                else if (params.type === 'notifyPromotion') {
                    yield processPromotionNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName);
                }
                else if (params.type === 'mcalpin') {
                    yield processMcAlpinNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, null);
                }
                else if (params.type === 'tauscher') {
                    yield processTauscherNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, null);
                }
                context.succeed({});
            }).catch(onerror);
        });
    }
    else {
        if (config.verbose) {
            console.log('No event object');
        }
        context.fail('Error: Invalid params');
    }
};

function isString(value) {
    return typeof value === 'string';
}

function setObjectAttribute(object, value, name, caps)
{
    if (object && value && name) {
        if (caps) {
            value = value.toUpperCase();
        }
        object[name] = value;
    }
}

function processPromotionNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName) {
    return co(function*() {
        if (config.verbose) {
            console.log('processPromotionNotification');
        }
        var message = {};    
        message.verb = 'notifyPromotion';
        message.stage = stage;
        message.notifyRequest = params;
        message.linkRoot = linkRoot;
        message.fromAddress = fromAddress;
        message.templateBucket = templateBucket;
        message.templateName = templateName;
                
        var payload = {
            default: JSON.stringify(message)
        };
                
        yield publishSNS(notifyUsersARN, payload, 'json');

    }).catch(function (err) {
        console.log(err);
    });
};

function formatTime(epoch, fmt) {
    return moment(epoch).tz('America/Los_Angeles').format(fmt);
}

function formatRange(start, end, fmt) {
    var from = formatTime(start, fmt);
    var to = formatTime(end, fmt);
    return from + ' - ' + to;
}

function processFeedbackNotification(db, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        if (config.verbose) {
            console.log('processFeedbackNotification');
        }
        for (var i = 0; i < config.feedbackEmails.length; i++) {
            var destEmail = config.feedbackEmails[i];
            yield sendEmail(fromAddress, destEmail, title, null, description, null);
        }
    }).catch(onerror);
};

function processEventCreateNotification(db, event_id, fromAddress, templateBody) {
    return co(function*() {
        if (config.verbose) {
            console.log('processEventCreateNotification');
        }
        
        var _evt = db.child("events/" + event_id);
        var evt = yield _evt.get();
        if (evt) {
            var eventCreator = '';
            if (evt.creatingUser) {
                var _creator = db.child("users/" + evt.creatingUser);
                var creator = yield _creator.get();
                if (creator) {
                    eventCreator = creator.firstName + " " + creator.lastName;
                }
            }
            var sentBy = null;
            var image = null;
            var title = evt.title + " (" + evt.number + ') was created';
            var description = evt.description;
            for (var i = 0; i < config.eventCreationNotifications.length; i++) {
                var mn = config.eventCreationNotifications[i];
                var _users = db.child("users/").orderByChild('memberNumber').equalTo(mn);
                var usersArray = yield _users.get();
                if (usersArray) {
                    var keys = Object.keys(usersArray);
                    for (var j = 0; j < keys.length; j++) {
                        var key = keys[j];
                        var user = usersArray[key];
                        if (user) {
                            var details = {
                                eventNumber: evt.number,
                                eventName: evt.title,
                                eventCreator: eventCreator,
                                creationTime: evt.timestamp?formatTime(evt.timestamp, "h:mm A"):'',
                                creationDate: evt.timestamp?formatTime(evt.timestamp, "MM/DD/YY"):'',
                                email: user.email,
                                subject: title
                            };

                            details = fillTemplate(templateBody, details);

                            yield sendNotification(db, user, user_id, params, template, title, description, sentBy, image, details, fromAddress);
                        }
                    }
                }
            }
        }
    }).catch(onerror);
};

function processChildcareNotification(db, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        if (config.verbose) {
            console.log('processChildNotification');
        }
        for (var i = 0; i < config.childcareEmails.length; i++) {
            var destEmail = config.feedbackEmails[i];
            yield sendEmail(fromAddress, destEmail, title, null, description, null);
        }
    }).catch(onerror);
};

function processMcAlpinNotification(db, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        if (config.verbose) {
            console.log('processMcAlpinNotification');
        }
        for (var i = 0; i < config.mcalpinEmails.length; i++) {
            var destEmail = config.mcalpinEmails[i];
            yield sendEmail(fromAddress, destEmail, title, null, description, null);
        }
    }).catch(onerror);
};

function processTauscherNotification(db, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        if (config.verbose) {
            console.log('processTauscherNotification');
            console.log({
                'fromAddress': fromAddress,
                'title': title,
                'description': description,
                'sentBy': sentBy,
                'image': image,
                'template': template
            });
        }
        for (var i = 0; i < config.tauscherEmails.length; i++) {
            var destEmail = config.tauscherEmails[i];
            yield sendEmail(fromAddress, destEmail, title, null, description, null);
        }
    }).catch(onerror);
};


function processClosureNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName) {
    return co(function*() {
        if (config.verbose) {
            console.log('processClosureNotification');
        }
        var message = {};
        message.verb = 'closure';
        message.stage = stage;
        message.notifyRequest = params;
        message.linkRoot = linkRoot;
        message.fromAddress = fromAddress;
        message.templateBucket = templateBucket;
        message.templateName = templateName;
        
        var payload = {
            default: JSON.stringify(message)
        };
        
        yield publishSNS(notifyUsersARN, payload, 'json');

    }).catch(function (err) {
        console.log(err);
    });
};

function processEmergencyNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName) {
    return co(function*() {
        if (config.verbose) {
            console.log('processEmergencyNotification');
        }
        var message = {};
        message.verb = 'emergency';
        message.stage = stage;
        message.notifyRequest = params;
        message.linkRoot = linkRoot;
        message.fromAddress = fromAddress;
        message.templateBucket = templateBucket;
        message.templateName = templateName;
        
        var payload = {
            default: JSON.stringify(message)
        };
        
        yield publishSNS(notifyUsersARN, payload, 'json');

    }).catch(function (err) {
        console.log(err);
    });
}

function processUserNotification(db, user_id, fromAddress, params, template) {
    return co(function*() {
        var title = params.title;
        var description = params.description;
        var sentBy = params.sentBy;
        var image = params.image;
        var _user = db.child("users/" + user_id);
        var user = yield _user.get();
        if (user) {
            var details = yield buildNotification(db, user, user_id, params, template, title, description, sentBy, image);
            yield sendNotification(db, user, user_id, params, template, title, description, sentBy, image, details, fromAddress);
        }
    }).catch(onerror);
};

function sendNotification(db, user, user_id, params, template, title, description, sentBy, image, details, fromAddress)
{
    return co(function*() {
        var sentNotification = false; var sentEmail = null;
        if (user.sendNotificationConfirmation) {
            //update just this attribute
            var _numNewNotifications = db.child('users/' + user_id + '/numNewNotifications');
            yield _numNewNotifications.transaction(function (numNewNotifications) {
                if (numNewNotifications === null) {
                    return 1;
                }
                else {
                    return numNewNotifications + 1;
                }
            });
        
            var key = db.generateUniqueKey();
            var _notification = db.child('notifications/' + key);
        
            var notification = {
                type: 'Reminder',
                timestamp: moment().valueOf(),
                title: title || '',
                description: description || '',
                user: user_id,
            };
        
            if (image) {
                notification.imageId = image;
            }
        
            yield _notification.set(notification);
            sentNotification = true;
        }
    
        if (user.sendEmailConfirmation) {
            yield sendEmail(fromAddress, details.email, details.subject, details.content, null, details.attachment);
            sentEmail = details.email;
        }
        if (sentEmail || sentNotification) {
            var _auditNotifications = db.child('auditNotifications');
            var auditEntry = {
                'sentEmail': sentEmail,
                'sentNotification': sentNotification,
                'notifiedName': user.firstName + " " + user.lastName,
                'notifiedMember': user.memberNumber,
                'type': params.type,
                'timestamp': moment().valueOf(),
                'title': title || '',
                'description' : description || ''
            };
            if (params.admin) {
                auditEntry.admin = params.admin;
            }
            if (params.adminName) {
                auditEntry.adminName = params.adminName;
            }
            if (params.eventName) {
                auditEntry.eventName = params.eventName;
            }
            if (params.eventNumber) {
                auditEntry.eventNumber = params.eventNumber;
            }
            if (params.eventDate) {
                auditEntry.eventDate = params.eventDate;
            }
            if (params.sessions) {
                auditEntry.sessions = params.sessions;
            }
            if (params.interests) {
                auditEntry.interests = params.interests;
            }
            if (params.locations) {
                auditEntry.locations = params.locations;
            }
            yield _auditNotifications.push(auditEntry);
        }
    }).catch(function (err) {
        console.log(err);
    });
}

function processEventNotification(db, event_id, fromAddress, params, template) {
    return co(function*() {
        var locations = [];
        var _evt = db.child("events/" + event_id);
        var evt = yield _evt.get();
        if (evt) {
            if (evt.interests) {
                for (var propertyName in evt.interests) {
                    params.interests.push(propertyName);
                }
            }
            if (evt.sessions) {
                params.sessions = [];
                for (var propertyName in evt.sessions) {
                    var _c = db.child('sessions/' + propertyName);
                    var session = yield _c.get();
                    if (session) {
                        var sessionLocationName = '';
                        if (session.location) {
                            locations.push(session.location);
                            var _sl = db.child('locations/' + session.location);
                            var sl = yield _sl.get();
                            if (sl) {
                                sessionLocationName = sl.name || '';
                            }
                        }
                        var sessionDetails = {
                            date: formatTime(session.date, 'MMM Do'),
                            startTime: formatTime(session.date, 'h:mm a'),
                            endTime: formatTime(session.date + (session.duration * 60000), 'h:mm a')
                        };
                        
                        if (session.instructor) {
                            sessionDetails.instructor = session.instructor;
                        }
                        if (sessionLocationName) {
                            sessionDetails.location = sessionLocationName;
                        }
                        params.sessions.push(sessionDetails);
                    }
                }
            }  
            
            if (evt.title && evt.number) {
                params.subject = evt.title + ' (' + evt.number + ')';
                params.eventName = evt.title;
                params.eventNumber = evt.number;

            }
            else {
                params.subject = 'Event notification';
            }
            
            if (locations.length) {
                params.locations = locations;
            }
            
            if (evt.startDate) {
                params.eventDate = formatTime(evt.startDate, 'MMM Do');
            }
            var registrationPromises = [];
            Object.keys(evt.registrations).forEach(function (key) {
                var _registration = db.child('registrations/' + key);
                registrationPromises.push(_registration.get());
            });

            var registrations = yield registrationPromises;
            for (var i = 0; i < registrations.length; ++i) {
                var registration = registrations[i];
                if (registration) {
                    yield processUserNotification(db, registration.registeredUser, fromAddress, params, template)
                }
            }
        }
    }).catch(onerror);
};

function processInterestNotification(db, interest_id, fromAddress, params, template) {
    return co(function*() {
        var sent = {};
        var interest = yield db.child("interests/" + interest_id).get();
        if (interest) {
            params.interest.push(interest_id);
            params.subject = interest.name + ' notification';
            if (interest.children)
            {
                var childInterestKeys = Object.keys(interest.children);
                for (var ci=0;ci< childInterestKeys.length;ci++) {
                    var uiPath = db.child("userInterests/").orderByChild('interest').equalTo(childInterestKeys[ci]);
                    var _userInterests = yield uiPath.get();
                    if (_userInterests) {
                        var userInterestKeys = Object.keys(_userInterests);
                        for (var ui = 0; ui < userInterestKeys.length; ui++) {
                            var key = userInterestKeys[ui];
                            var userInterest = _userInterests[key];
                            if (userInterest) {
                                if (sent[userInterest.user] === undefined) {
                                    sent[userInterest.user] = true;
                                    yield processUserNotification(db, userInterest.user, fromAddress, params, template);
                                }
                            }
                        }
                    }
                }
            }
            
            //and now the interest
            var iPath = db.child("userInterests/").orderByChild('interest').equalTo(interest_id);
            var _desiredUserInterests = yield iPath.get();
            if (_desiredUserInterests) {
                var desiredUserInterests = Object.keys(_desiredUserInterests);
                for (var dui = 0; dui < desiredUserInterests.length; dui++) {
                    var key = desiredUserInterests[dui];
                    var desiredUserInterest = _desiredUserInterests[key];
                    if (desiredUserInterest) {
                        if (sent[desiredUserInterest.user] === undefined) {
                            sent[desiredUserInterest.user] = true;
                            yield processUserNotification(db, desiredUserInterest.user, fromAddress, params, template);
                        }
                    }
                }
            }
        }
    }).catch(onerror);
};

function buildNotification(db, user, user_id, params, template, title, description, sentBy, image) {
    var details = {
        memberName: user.fullName,
        user_id: user_id,
        email: user.email,
        title: title,
        description: description,
        sentBy: sentBy,
        image: image,
        subject: params.subject
    };
    
    if (params.eventName) {
        details.eventName = params.eventName;
    }
    
    if (params.eventNumber) {
        details.eventNumber = params.eventNumber;
    }
    
    if (params.eventDate) {
        details.eventDate = params.eventDate;
    }
    
    if (params.sessions) {
        details.sessions = params.sessions;
    }
    
    return fillTemplate(template, details);
}

function fillTemplate(template, details)        
{
    var mark = require('markup-js');
    if (template) {
        details.content = mark.up(template, details);
    }
    return details;
};


function sendEmail(fromAddress, to, subject, content, message, attachment) {
    return new Promise(function (resolve, reject) {
        var attachments = [];
        if (attachment) {
            attachments.push(attachment);
        }
        transporter.sendMail({
            from: fromAddress,
            to: to,
            subject: subject,
            html: content,
            text: message,
            attachments: attachments
        }, function (error, info) {
            if (error) {
                if (config.verbose) {
                    console.log('sendEmail error');
                    console.log(error);
                }
                if (info) {
                    console.log(info);
                }
                reject(error);
            }
            if (config.verbose) {
                console.log('email sent');
            }
            resolve();
        });
    });
}

function publishSNS(notifyUsersARN, payload, messageStructure) {
    return new Promise(function (resolve, reject) {
        SNS.publish({
            TopicArn: notifyUsersARN,
            Message: JSON.stringify(payload),
            MessageStructure: 'json'
        }, function (err, data) {
            if (err) {
                console.log(err);
                reject(err);
            }
            resolve();
        });
    });
}

function getS3Object(templateBucket, templateName)
{
    return new Promise(function (resolve, reject) {
        s3.getObject({
            Bucket: templateBucket, 
            Key: templateName
        }, function (err, template) {
            if (err) {
                if (config.verbose) {
                    console.log(err, err.stack); // an error occurred
                }
                reject();
            }
            else {
                resolve(template);
            }
        });
    });
}

