var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment');
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
        var bulkARN = null;
        var linkRoot = null;
        if (stage === 'v0') {
            templateBucket = config.prodTemplateBucket;
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
            fromAddress = config.prodFromAddress;
            bulkARN = config.prodBulkARN;
            linkRoot = config.prodLinkRoot;
        }
        else if (stage === 'v0_2') {
            templateBucket = config.prod2TemplateBucket;
            authToken = config.prod2Secret;
            firebaseUrl = config.prod2FirebaseUrl;
            fromAddress = config.prodFromAddress;
            bulkARN = config.prod2BulkARN;
            linkRoot = config.prod2LinkRoot;
        }
        else {
            templateBucket = config.devTemplateBucket;
            authToken = config.devSecret;
            firebaseUrl = config.devFirebaseUrl;
            fromAddress = config.fromAddress;
            bulkARN = config.devBulkARN;
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
            
            s3.getObject({
                Bucket: templateBucket, 
                Key: templateName
            }, function (err, template) {
                if (err) {
                    if (config.verbose) {
                        console.log(err, err.stack); // an error occurred
                    }
                    context.fail(err.stack);
                }
                else {
                    co(function*() {
                        var templateBody = template.Body.toString();
                        if (params.type === 'interest') {
                            yield processInterestNotification(db, params.id, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'event') {
                            yield processEventNotification(db, params.id, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'user') {
                            yield processUserNotification(db, params.id, result, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'closure') {
                            yield processClosureNotification(db, params.id, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'emergency') {
                            yield processEmergencyNotification(db, params.id, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'feedback') {
                            yield processFeedbackNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'childcare') {
                            yield processChildcareNotification(db, fromAddress, params.title, params.description, params.sentBy, params.image, templateBody);
                        }
                        else if (params.type === 'notifyPromotion') {

                            yield processPromotionNotification(db, fromAddress, stage, linkRoot, params.specialCaption, params.draft, bulkARN, params.subject, params.contactInfo, params.interests, params.includeParkingProjection, params.eventDetails, templateBody);
                        }
                        context.succeed({});
                    }).catch(onerror);
                }
            });
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

function processPromotionNotification(db, fromAddress,stage, linkRoot, specialCaption, draft, bulkARN, subject, contactInfo, interests, includeParkingProjection, eventDetails, template) {
    return co(function*() {
        if (fromAddress && interests && eventDetails && eventDetails.length > 0 && template) {
            if (config.verbose) {
                console.log('processPromotionNotification');
            }
            
            var details = {};
            
            if (eventDetails.length >= 1) {
                var eventDetail = eventDetails[0];
                if (eventDetail) {
                    details.eventTitle1 = eventDetail.title;
                    details.eventDescription1 = eventDetail.description;
                    var _event1 = db.child('events/' + eventDetail.id);
                    var event1 = yield _event1.get();
                    if (event1) {
                        if (event1.largest) {
                            details.image1 = event1.largest;
                        }
                        if (event1.startDate) {
                            details.eventDateTime1 = formatTime(event1.startDate, 'MM/DD/YY @ h:mm A');
                        }
                    }
                    details.eventLink1 = linkRoot + "/event/" + eventDetail.id;
                }
            }
            if (eventDetails.length >= 2) {
                var eventDetail = eventDetails[1];
                if (eventDetail) {
                    details.eventTitle2 = eventDetail.title;
                    details.eventDescription2 = eventDetail.description;
                    var _event2 = db.child('events/' + eventDetail.id);
                    var event2 = yield _event2.get();
                    if (event2) {
                        if (event2.largest) {
                            details.image2 = event2.largest;
                        }
                        if (event2.startDate) {
                            details.eventDateTime2 = formatTime(event2.startDate, 'MM/DD/YY @ h:mm A');
                        }
                    }
                    details.eventLink2 = linkRoot + "/event/" + eventDetail.id;
                }
            }
            if (eventDetails.length >= 3) {
                var eventDetail = eventDetails[2];
                if (eventDetail) {
                    details.eventTitle3 = eventDetail.title;
                    details.eventDescription3 = eventDetail.description;
                    var _event3 = db.child('events/' + eventDetail.id);
                    var event3 = yield _event3.get();
                    if (event3) {
                        if (event3.largest) {
                            details.image3 = event3.largest;
                        }
                        if (event3.startDate) {
                            details.eventDateTime3 = formatTime(event3.startDate, 'MM/DD/YY @ h:mm A');
                        }
                    }
                    details.eventLink3 = linkRoot + "/event/" + eventDetail.id;
                }
            }
            if (eventDetails.length >= 4) {
                var eventDetail = eventDetails[3];
                if (eventDetail) {
                    details.eventTitle4 = eventDetail.title;
                    details.eventDescription4 = eventDetail.description;
                    var _event4 = db.child('events/' + eventDetail.id);
                    var event4 = yield _event4.get();
                    if (event4) {
                        if (event4.largest) {
                            details.image4 = event4.largest;
                        }
                        if (event4.startDate) {
                            details.eventDateTime4 = formatTime(event4.startDate, 'MM/DD/YY @ h:mm A');
                        }
                    }
                    details.eventLink4 = linkRoot + "/event/" + eventDetail.id;
                }
            }
            
            if (linkRoot) {
                details.parkingLink = linkRoot + "/parking";
            }

            if (contactInfo) {
                details.contactInfo = contactInfo;
            }
            
            if (specialCaption) {
                details.specialCaption = specialCaption;
            }
            
            if (config.verbose) {
                console.log(details);
                console.log(bulkARN);
            }

            var mark = require('markup-js');
            
            var message = {};
            if (template) {
                try {
                    message.content = mark.up(template, details);
                }
                catch (e) {
                    console.log(e);
                }
            }
            
            
            
            var _users = db.child("users");
            var users = yield _users.get();
            
            if (users) {
                var emails = {};
                
                for (var i = 0; i < interests.length; i++) {
                    var _interestedUsers = db.child("userInterests/").orderByChild('interest').equalTo(interests[i]);
                    var interestedUsers = yield _interestedUsers.get();
                    if (interestedUsers) {
                        var interestedUserKeys = Object.keys(interestedUsers);
                        for (var j = 0; j < interestedUserKeys.length; j++) {
                            var key = interestedUserKeys[j];
                            var iu = interestedUsers[key].user;
                            var user = users[iu];
                            if (user && user.email) {
                                emails[iu] = user.email;
                            }
                        }
                    }
                }
                message.stage = stage;
                message.emails = emails;
                message.fromAddress = fromAddress;
                message.subject = subject;
                message.draft = draft;
                
                var payload = {
                    default: JSON.stringify(message)
                };
                
                yield publishSNS(bulkARN, payload, 'json');
            }
            else {
                console.log("no users found");
            }
        }

    }).catch(function (err) {
        console.log(err);
    });
};

function formatTime(epoch, fmt) {
    return moment(epoch).utcOffset(-8).format(fmt);
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



function processClosureNotification(db, notification_id, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        var _responses = db.child("notificationResponses/").orderByChild('notification').equalTo(notification_id);
        var responses = yield _responses.get();
        if (responses) {
            var responseKeys = Object.keys(responses);
            for (var i = 0; i < responseKeys.length; i++) {
                var key = responseKeys[i];
                var _resp = db.child('notificationResponses/' + key);
                yield _resp.remove();
            }
        }
    }).catch(onerror);
};

function processEmergencyNotification(db, notification_id, fromAddress, title, description, sentBy, image, template) {
    return co(function*() {
        
        if (config.verbose) {
            console.log('processEmergencyNotification');
            console.log({
                'notification_id': notification_id,
                'fromAddress': fromAddress,
                'title': title,
                'description': description,
                'sentBy': sentBy,
                'image': image,
            });
        }
        
        var promises = [];
        
        if (config.verbose) {
            console.log('notificationResponses');
        }
        var _responses = db.child("notificationResponses/").orderByChild('notification').equalTo(notification_id);
        var responses = yield _responses.get();
        if (responses) {
            if (config.verbose) {
                console.log('responses');
            }
            var responseKeys = Object.keys(responses);
            for (var i = 0; i < responseKeys.length; i++) {
                var key = responseKeys[i];
                var _resp = db.child('notificationResponses/' + key);
                promises.push(_resp.remove());
            }
        }
        
        var _notifyUsers = db.child('users/').orderByChild('sendNotificationConfirmation').equalTo(true);
        var notifyUsers = yield _notifyUsers.get();
        if (notifyUsers) {
            
            var notifyUsersKeys = Object.keys(notifyUsers);
            for (var ui = 0; ui < notifyUsersKeys.length; ui++) {
                var key = notifyUsersKeys[ui];
                var notifyUser = notifyUsers[key];
                if (notifyUser) {
                    if (notifyUser.numNewNotifications) {
                        notifyUser.numNewNotifications++;
                    }
                    else {
                        notifyUser.numNewNotifications = 1;
                    }
                    var _user = db.child('users/' + key +'/numNewNotifications');
                    
                    promises.push(_user.set(notifyUser.numNewNotifications));
                }
            }
        }
        
        var _notifyEmails = db.child('users/').orderByChild('sendEmailConfirmation').equalTo(true);
        var notifyEmails = yield _notifyEmails.get();
        if (notifyEmails) {
            var notifyEmailKeys = Object.keys(notifyEmails);
            
            for (var ui = 0; ui < notifyEmailKeys.length; ui++) {
                var key = notifyEmailKeys[ui];
                var notifyEmail = notifyEmails[key];
                if (notifyEmail) {
                    var details = yield buildNotification(db, notifyEmail, key, template, title, description, sentBy, image);
                    yield sendEmail(fromAddress, details.email, details.subject, details.content, null, details.attachment);
                }
            }
            
        }
        yield promises;
    }).catch(function (err) {
        if (config.verbose) {
            console.error(err.stack);
        }
    });
};




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

function publishSNS(bulkARN, payload, messageStructure) {
    return new Promise(function (resolve, reject) {
        SNS.publish({
            TopicArn: bulkARN,
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

