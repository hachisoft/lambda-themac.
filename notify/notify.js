var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment-timezone');

var thunkify = require('thunkify');
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

        NodeFire.setCacheSize(10);
        NodeFire.DEBUG = true;
        var db = new NodeFire(firebaseUrl);
        db.auth(authToken).then(function () {
            if (config.verbose) {
                console.log('Auth succeeded');
                console.log({'templateBucket':templateBucket,'templateName':templateName});
            }
            co(function*() {
                if (params.type === 'interest') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        yield processInterestNotification(db, params.id, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                    }
                }
                else if (params.type === 'event') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        yield processEventNotification(db, params.id, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                    }
                }
                else if (params.type === 'user') {
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        var templateBody = template.Body.toString();
                        yield processUserNotification(db, params.id, result, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
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
                        yield processEventCreateNotification(db, params.id, result, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                    }
                }
                else if (params.type === 'childcare') {
                    yield processChildcareNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, null);
                }
                else if (params.type === 'notifyPromotion') {
                    yield processPromotionNotification(fromAddress, stage, linkRoot, notifyUsersARN, params, templateBucket, templateName);
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

function processUserNotification(db, user_id, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        var _user = db.child("users/" + user_id);
        var user = yield _user.get();
        if (user) {
            var details = yield buildNotification(db, user, user_id, template, title, description, sentBy, image);
            if (user.sendNotificationConfirmation) {
                //update just this attribute
                var _user = db.child('users/' + user_id + '/numNewNotifications');
                if (user.numNewNotifications) {
                    user.numNewNotifications++;
                }
                else {
                    user.numNewNotifications = 1;
                }
                yield _user.set(user.numNewNotifications);
                var key = db.generateUniqueKey();
                var _notification = db.child('notifications/' + key);
                
                var notification = {
                    type: 'Reminder',
                    timestamp: moment().valueOf(),
                    title: title,
                    description: description,
                    user: user_id,
                    imageId: image
                };
                yield _notification.set(notification);
            }
            
            if (user.sendEmailConfirmation) {
                yield sendEmail(fromAddress, details.email, details.subject, details.content, null, details.attachment);
            }
        }
    }).catch(onerror);
};

function processEventCreationNotification(db, user_id, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        if (config.verbose) {
            console.log('processEventCreationNotification');
        }

        for (var i = 0; i < config.eventCreationUsers.length; i++) {
            var memberNumber = config.eventCreationUsers[i];
            var _user = db.child("users/").orderByChild('memberNumber').equalTo(memberNumber);
            var user = yield _user.get();
            if (user) {
                var details = yield buildNotification(db, user, user_id, template, title, description, sentBy, image);
                if (user.sendNotificationConfirmation) {
                    //update just this attribute
                    var _user = db.child('users/' + user_id + '/numNewNotifications');
                    if (user.numNewNotifications) {
                        user.numNewNotifications++;
                    }
                    else {
                        user.numNewNotifications = 1;
                    }
                    yield _user.set(user.numNewNotifications);
                    var key = db.generateUniqueKey();
                    var _notification = db.child('notifications/' + key);
                    
                    var notification = {
                        type: 'Reminder',
                        timestamp: moment().valueOf(),
                        title: title,
                        description: description,
                        user: user_id,
                        imageId: image
                    };
                    yield _notification.set(notification);
                }
                
                if (user.sendEmailConfirmation) {
                    yield sendEmail(fromAddress, details.email, details.subject, details.content, null, details.attachment);
                }
            }
        }
    }).catch(onerror);
};

function processEventNotification(db, event_id, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        var _evt = db.child("events/" + event_id);
        var evt = yield _evt.get();
        if (evt) {
            var registrationPromises = [];
            Object.keys(evt.registrations).forEach(function (key) {
                var _registration = db.child('registations/' + key);
                registrationPromises.push(_registration.get());
            });

            var registrations = yield registrationPromises;
            for (var i = 0; i < registrations.length; ++i) {
                var registration = registrations[i];
                if (registration) {
                    yield processUserNotification(db, registration.registeredUser, fromAddress, title, description, sentBy, image, template)
                }
            }
        }
    }).catch(onerror);
};

function processInterestNotification(db, interest_id, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        var sent = {};
        var interest = yield db.child("interests/" + interest_id).get();
        if (interest) {
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
                                    yield processUserNotification(db, userInterest.user, fromAddress, title, description, sentBy, image, template);
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
                            yield processUserNotification(db, desiredUserInterest.user, fromAddress, title, description, sentBy, image, template);
                        }
                    }
                }
            }
        }
    }).catch(onerror);
};

function buildNotification(db, user, user_id, template, title, description, sentBy, image) {
    var mark = require('markup-js');
        
    var details = {
        memberName: user.fullName,
        user_id: user_id,
        email: user.email,
        title: title,
        description: description,
        sentBy: sentBy,
        image: image
    };
        
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

