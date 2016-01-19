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

var nodemailer = require('nodemailer');
var ses = require('nodemailer-ses-transport');


var transporter = nodemailer.createTransport(ses({
    region: 'us-west-2'
}));

console.log('started notify.js');

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    console.error(err.stack);
}

exports.handler = function (event, context) {
    var stage = event.stage || 'dev';
    var result = '';
    if (event) {
        // Read options from the event.
        console.log("Reading options from event:\n", util.inspect(event, { depth: 5 }));
        
        var fromAddress = null;
        var firebaseUrl = null;
        var authToken = null;
        var templateBucket = '';
        if (stage === 'v0') {
            templateBucket = config.prodTemplateBucket;
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
            fromAddress = config.prodFromAddress;
        }
        else if (stage === 'v0_2') {
            templateBucket = config.prod2TemplateBucket;
            authToken = config.prod2Secret;
            firebaseUrl = config.prod2FirebaseUrl;
            fromAddress = config.prodFromAddress;
        }
        else {
            templateBucket = config.devTemplateBucket;
            authToken = config.devSecret;
            firebaseUrl = config.devFirebaseUrl;
            fromAddress = config.fromAddress;
        }
        
        console.log(config);
        
        NodeFire.setCacheSize(10);
        NodeFire.DEBUG = true;
        var db = new NodeFire(firebaseUrl);
        db.auth(authToken).then(function () {
            console.log('Auth succeeded');
            var templateName = "notification.html";
            s3.getObject({
                Bucket: templateBucket, 
                Key: templateName
            }, function (err, template) {
                if (err) {
                    console.log(err, err.stack); // an error occurred
                }
                else {
                    co(function*() {
                        var templateBody = template.Body.toString();
                        if (event.type === 'interest') {
                            yield processInterestNotification(db, event.id, fromAddress, event.title, event.description, event.sentBy, templateBody);
                        }
                        else if (event.type === 'event') {
                            yield processEventNotification(db, event.id, fromAddress, event.title, event.description, event.sentBy, templateBody);
                        }
                        else if (event.type === 'user') {
                            yield processUserNotification(db, event.id, result, fromAddress, event.title, event.description, event.sentBy, templateBody);
                        }

                        context.succeed({});
                    }).catch(onerror);
                }
            });
        });
    }
    else {
        console.log('No event object');

    }
};

function processUserNotification(db, user_id, fromAddress, title, description, sentBy, template) {
    var p = "users/" + user_id;
    return co(function*() {
        var path = db.child(p);
        var user = yield path.get();
        if (user) {
            var details = yield buildNotification(db, user, user_id, template, title, description, sentBy);
            if (user.sendNotificationConfirmation) {
                var key = db.generateUniqueKey();
                var _notification = db.child('notifications/' + key);
                
                var notification = {
                    type: 'Reminder',
                    timestamp: moment().valueOf(),
                    title: title,
                    description: description,
                    user: user_id
                };
                yield _notification.set(notification);
            }
            
            if (user.sendEmailConfirmation) {
                transporter.sendMail({
                    from: fromAddress,
                    to: user.email,
                    subject: title,
                    html: details.content
                }, function (error, info) {
                    if (error) {
                        console.log(error);
                    }
                    else if (info) {
                        console.log(info);
                    }
                });
            }
        }
    }).catch(onerror);
};

function processEventNotification(db, event_id, fromAddress, title, description, sentBy, template) {
    return co(function*() {
        var p = "events/" + event_id;
        var path = db.child(p);
        var evt = yield path.get();
        if (evt) {
            var registrations = Object.keys(evt.registrations);
            registrations.forEach(function (key) {
                var reg = db.child("registrations/" + key);
                reg.get().then(function (registration) {
                    if (registration) {
                        processUserNotification(db, registration.registeredUser, fromAddress, title, description, sentBy, template)
                    }
                });
            });
        }
    }).catch(onerror);
};

function processInterestNotification(db, interest_id, fromAddress, title, description, sentBy, template) {
    return co(function*() {
        var interest = yield db.child("interests/" + interest_id).get();
        if (interest) {
            if (interest.children)
            {
                var childInterests = Object.keys(interest.children);
                for (var ci=0;ci<childInterests.length;ci++) {
                    var uiPath = db.child("userInterests/").orderByChild('interest').equalTo(childInterests[ci]);
                    var _userInterests = yield uiPath.get();
                    if (_userInterests) {
                        var userInterests = Object.keys(_userInterests);
                        for (var ui = 0; ui < userInterests.length; ui++) {
                            var key = userInterests[ui];
                            var userInterest = _userInterests[key];
                            if (userInterest) {
                                yield processUserNotification(db, userInterest.user, fromAddress, title, description, sentBy, template);
                            }
                        }
                    }
                }
            }
            
            //and now the interest
            var iPath = db.child("userInterests/").orderByChild('interest').equalTo(interest_id);
            var _userInterests = yield iPath.get();
            if (_userInterests) {
                if (_userInterests) {
                    var userInterests = Object.keys(_userInterests);
                    for (var ui = 0; ui < userInterests.length; ui++) {
                        var key = userInterests[ui];
                        var userInterest = _userInterests[key];
                        if (userInterest) {
                            yield processUserNotification(db, userInterest.user, fromAddress, title, description, sentBy, template);
                        }
                    }
                }
        }
    }).catch(onerror);
};

function buildNotification(db, user, user_id, template, title, description, sentBy) {
    var mark = require('markup-js');
        
    var details = {
        memberName: user.fullName,
        user_id: user_id,
        email: user.email,
        title: title,
        description: description,
        sentBy: sentBy
    };
        
    if (template) {
        details.content = mark.up(template, details);
    }
        
    return details;
};


