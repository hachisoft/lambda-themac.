var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment');
var thunkify = require('thunkify');
var config = require('./config.js');

var S3 = require('./co-s3.js');

var s3 = new S3();

var nodemailer = require('nodemailer');
var ses = require('nodemailer-ses-transport');


var transporter = nodemailer.createTransport(ses({
    region: 'us-west-2'
}));

exports.handler = function (event, context) {
    var response = {
        'r':'something',
        'success_action_status': '201'
    };
    
    context.succeed(response);
    var stage = event.stage || 'dev';
    var result = '';
    if (event && event.registrations) {
        console.log('event = ' + JSON.stringify(event));
        
        
        var firebaseUrl = null;
        var authToken = null;
        if (stage !== 'dev') {
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
        }
        else {
            config.templateBucket = 'dev.' + config.templateBucket;
            authToken = config.devSecret;
            firebaseUrl = config.devFirebaseUrl;
        }
        
        NodeFire.setCacheSize(10);
        NodeFire.DEBUG = true;
        var db = new NodeFire(firebaseUrl);
        db.auth(authToken).then(function () {
            var totalCost = event.totalCost || null;
            var adultCount = event.adultCount || null;
            var juniorCount = event.juniorCount || null;
            
            for (var i = 0; i < event.registrations.length; i++)
            {
                var _registration = db.child('registrations/' + event.registrations[i]);
                if (_registration) {
                    _registration.get().then(function (registration) {
                        if (registration) {
                            if (registration.status === "Pending") {
                                processRegistration(db, registration, totalCost, adultCount, juniorCount);
                            }
                        }
                    });
                }
            }
        });
    }
    else {
        console.log('No event object');

    }
    
    context.done(null, result);
};

function processRegistration(db, registration, totalCost, adultCount, juniorCount) {
    var _event = db.child('events/' + registration.event);
    if (_event) {
        _event.get().then(function (event) {
            console.log(event);
            if (event) {
                var _confirmation = null;
                if (event.confirmation)
                    _confirmation = db.child('confirmations/' + event.confirmation);
                var _registeredUser = db.child('users/' + registration.registeredUser);
                var _registeringUser = db.child('users/' + registration.registeringUser);
                co(function*() {
                    var confirmation = null;
                    if (_confirmation)
                        confirmation = yield _confirmation.get();
                    var registeredUser = yield _registeredUser.get();
                    var registeringUser = yield _registeringUser.get();
                    if (validateRegistration(db, registeredUser, registration)) {
                        var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                        updateRegistration(db, registration);
                        var details = yield buildConfirmation(db, registeredUser, registration.registeredUser, event, registration, 'confirmation.html', totalCost, adultCount, juniorCount, primaryMemberConfirmation);
                        //send each person on the confirmation their conf
                        if (details) {
                            sendConfirmation(db, registeredUser, registration.registeredUser, details);
                        }
                        
                        if (!primaryMemberConfirmation) { //now send one to the registering user also
                            details = yield buildConfirmation(db, registeringUser, registration.registeringUser, event, registration, 'confirmation.html', totalCost, adultCount, juniorCount, true);
                            //send each person on the confirmation their conf
                            if (details) {
                                sendConfirmation(db, registeringUser, registration.registeringUser, details);
                            }
                        }
                    }
                }).catch(onerror);
            }
        });
    }
};

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    console.error(err.stack);
}

function validateRegistration(db, user, registration) {
    return true;
};

function updateRegistration(db, registration) {

};

function sendConfirmation(db, user, user_id, details) {
    co(function*() {
        
        if (user.sendNotificationConfirmation) {
            var key = db.generateUniqueKey();
            var _notification = db.child('notifications/' + key);
            
            var notification = {
                type: 'Confirmation',
                timestamp: moment().valueOf(),
                title: details.eventName,
                description: details.eventDescription,
                user: user_id
            };
            yield _notification.set(notification);
        }
        
        if (user.sendEmailConfirmation) {
            
            transporter.sendMail({
                from: 'contact@hachisoft.com',
                to: details.email,
                subject: details.eventName,
                html: details.content
            }, function (error, info) {
                if (error) {
                    return console.log(error);
                }
                console.log('Message sent: ' + info.response);
            });
        }
    }).catch(onerror);
};

function buildConfirmation(db, user, user_id, event, registration, templateName, totalCost, adultCount, juniorCount, primaryMemberConfirmation) {
    return co(function*() {
        var mark = require('markup-js');
        
        var sessions = [];
        if (event.sessions) {
            for (var propertyName in event.sessions) {
                var _c = db.child('sessions/' + propertyName);
                var session = yield _c.get();
                if (session) {
                    sessions.push({
                        date: moment(session.date).format('MMM'),
                        startTime: moment(session.date).format('h:mm a'),
                        endTime: moment(session.date + (session.duration * 60000)).format('h:mm a'),
                        instructor: session.instructor
                    });
                }
            }
        }
        
        var details = {
            memberName: user.fullName,
            user_id: user_id,
            email: user.email,
            primaryMemberConfirmation: primaryMemberConfirmation,
            eventName: event.title,
            eventNumber: event.number,
            eventDate: moment(event.startDate).format('MMM'),
            eventDescription: event.description,
            sessions: sessions,
            adultCount: adultCount,
            juniorCount: juniorCount,
            totalCost: totalCost,
            comments: registration.comments,
            cancelBy: moment(event.cancelBy).format('MMM at h:mm a')
        };
        
        var template = yield s3.getObject({
            Bucket: config.templateBucket, 
            Key: templateName
        });
        if (template) {
            var templateBody = template.Body.toString();
            details.content = mark.up(templateBody, details);
        }
        
        return details;
        
    }).catch(onerror);
};