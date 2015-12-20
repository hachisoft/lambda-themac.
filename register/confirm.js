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

console.log('started confirm.js');

exports.handler = function (event, context) {
    var stage = event.stage || 'dev';
    var result = '';
    if (event && (event.registrations||event.reservation)) {
        console.log('event = ' + JSON.stringify(event));
        
        
        var firebaseUrl = null;
        var authToken = null;
        var fromAddress = null;
        var templateBucket = config.templateBucket;
        if (stage !== 'dev') {
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
            fromAddress = config.prodFromAddress;
        }
        else {
            templateBucket = 'dev.' + templateBucket;
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
            if (event.reservation) {
                var _reservation = db.child('reservations/' + event.reservation);
                _reservation.get().then(function (reservation) {
                    if (event.verb === 'Reserve') {
                        processReservation(event.verb, db, context, _reservation, reservation, event.reservation, fromAddress, templateBucket);
                    }
                    else if (event.verb === 'Cancel') {
                        processReservationCancel(event.verb, db, context, _reservation, reservation, event.reservation, fromAddress, templateBucket);
                    }
                });
            }
            else {
                var totalCost = event.totalCost || null;
                var adultCount = event.adultCount || null;
                var juniorCount = event.juniorCount || null;
                
                var noneMatched = true;
                var promises = [];
                var _registrations = [];
                for (var i = 0; i < event.registrations.length; i++) {
                    var _registration = db.child('registrations/' + event.registrations[i]);
                    if (_registration) {
                        _registrations.push(_registration);
                        promises.push(_registration.get());
                    }
                }
                co(function*() {
                    var registrations = yield promises;
                    for (var k = 0; k < registrations.length; k++) {
                        var registration = registrations[k];
                        if (registration) {
                            if (event.verb === "Register" && registration.status === "Pending") {
                                noneMatched = false;
                                processRegistration(event.verb, db, context, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket);
                            }
                            else if (event.verb === "Cancel" && registration.status === "Reserved") {
                                noneMatched = false;
                                processCancellation(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (event.verb === "Modify" && registration.status === "Reserved") {
                                noneMatched = false;
                                processModification(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (event.verb === "Waitlist" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                processWaitlist(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (event.verb === "WaitlistModify" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                processWaitlistModify(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                        }
                    }
                });
                
                if (noneMatched) {
                    console.log("No registrations matched the desired status");
                    context.succeed(
                        {
                            result: "No registrations matched the desired status",
                            verb: event.verb
                        });
                }
            }
        });
    }
    else {
        console.log('No event object');
        context.fail();
    }
};

function processReservation(verb, db, context, _reservation, reservation, reservation_id, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    console.log("processReservation");
    co(function*() {
        var _session = db.child('sessions/' + reservation.session);
        var _reservationUser = db.child('users/' + reservation.reservationUser);
        var _reservingUser = db.child('users/' + reservation.reservingUser);
        var _location = db.child('locations/' + reservation.location);
        var _interest = db.child('interests/' + reservation.interest);
        var _userReservationsForInterest = db.child("reservations/").orderByChild('reservationUser').equalTo(reservation.reservationUser);
        var _locationReservations = db.child("reservations/").orderByChild('location').equalTo(reservation.location);
        var _rules = db.child("rules/");
        var session = yield _session.get();
        var location = yield _location.get();
        var interest = yield _interest.get();
        
        var _reservationRule = db.child('reservationRules/' + interest.reservationRule);
        var reservationRule= yield _reservationRule.get();
        var reservationUser = yield _reservationUser.get();
        var reservingUser = yield _reservingUser.get();
        var _urfi = yield _userReservationsForInterest.get();
        var _lr = yield _locationReservations.get();
        var _r = yield _rules.get();
        var userReservationsForInterest = [];
        var locationReservations = [];
        var rules = [];
        if (_urfi) {
            Object.keys(_urfi).forEach(function (key) {
                if (_urfi[key].interest === reservation.interest)
                    userReservationsForInterest.push(_urfi[key]);
            });
        }
        if (_lr) {
            Object.keys(_lr).forEach(function (key) {
                locationReservations.push(_lr[key]);
            });
        }
        if (_r) {
            Object.keys(_r).forEach(function (key) {
                var rule = _r[key];
                var ruleLocations = Object.keys(rule.locations);
                for (var k = 0; k < ruleLocations.length; k++) {
                    if (ruleLocations[k] === reservation.location) {
                        rules.push(rule);
                    }
                }
            });
        }
        
        if (session && reservationUser) {
            if (validateReservation(db, reservationUser, reservation, location, interest, userReservationsForInterest, locationReservations, reservationRule, rules)) {
                reservation.status = "Reserved";
                
                var primaryMemberConfirmation = reservation.reservingUser === reservation.reservationUser;
                updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
                var details = yield buildConfirmation(verb, db, reservationUser, reservation.reservationUser, null, null, reservation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
                //send each person on the confirmation their conf
                if (details) {
                    yield sendConfirmation(db, reservationUser, reservation.reservationUser, details, fromAddress);
                }
                
                if (!primaryMemberConfirmation) { //now send one to the reserving user also
                    details = yield buildConfirmation(verb, db, reservingUser, reservation.reservingUser, null, null, reservation, null, totalCost, adultCount, juniorCount, true, templateBucket);
                    //send each person on the confirmation their conf
                    if (details) {
                        yield sendConfirmation(db, reservationUser, reservation.reservationUser, details, fromAddress);
                    }
                }
                context.succeed({});
            }
            else {
                updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
            }
        }
    }).catch(onerror);
};

function processReservationCancel(verb, db, context, _reservation, reservation, reservation_id, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    console.log("processReservationCancel");
    co(function*() {
        var _session = db.child('sessions/' + reservation.session);
        var _reservationUser = db.child('users/' + reservation.reservationUser);
        var _reservingUser = db.child('users/' + reservation.reservingUser);
        var _location = db.child('locations/' + reservation.location);
        var _interest = db.child('interests/' + reservation.interest);
        var _userReservationsForInterest = db.child("reservations/").orderByChild('reservationUser').equalTo(reservation.reservationUser);
        var _locationReservations = db.child("reservations/").orderByChild('location').equalTo(reservation.location);
        var _rules = db.child("rules/");
        var session = yield _session.get();
        var location = yield _location.get();
        var interest = yield _interest.get();
        
        var reservationUser = yield _reservationUser.get();
        var reservingUser = yield _reservingUser.get();
        var _urfi = yield _userReservationsForInterest.get();
        var _lr = yield _locationReservations.get();
        var userReservationsForInterest = [];
        var locationReservations = [];
        if (_urfi) {
            Object.keys(_urfi).forEach(function (key) {
                if (_urfi[key].interest === reservation.interest)
                    userReservationsForInterest.push(_urfi[key]);
            });
        }
        if (_lr) {
            Object.keys(_lr).forEach(function (key) {
                locationReservations.push(_lr[key]);
            });
        }
        
        if (session && reservationUser) {
            reservation.status = "Cancelled";
                
            var primaryMemberConfirmation = reservation.reservingUser === reservation.reservationUser;
            updateReservation(verb, db, _reservation, reservation,reservation_id, _session,session,_location,location,_reservationUser,reservationUser,_reservingUser,reservingUser,_interest,interest);
            var details = yield buildConfirmation(verb, db, reservationUser, reservation.reservationUser, null, null, reservation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
            //send each person on the confirmation their conf
            if (details) {
                yield sendConfirmation(db, reservationUser, reservation.reservationUser, details, fromAddress);
            }
                
            if (!primaryMemberConfirmation) { //now send one to the reserving user also
                details = yield buildConfirmation(verb, db, reservingUser, reservation.reservingUser, null, null, reservation, null, totalCost, adultCount, juniorCount, true, templateBucket);
                //send each person on the confirmation their conf
                if (details) {
                    yield sendConfirmation(db, reservationUser, reservation.reservationUser, details, fromAddress);
                }
            }
            context.succeed({});
        }
    }).catch(onerror);
};

function updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest) {
    if (reservation && session && location && reservationUser && reservingUser && interest) {
        co(function*() {
            if (verb === 'Cancel') {
                delete reservationUser.reservations[reservation_id];
                delete reservingUser.createdReservations[reservation_id];
                delete location.reservations[reservation_id];
                delete location.sessions[reservation.session];
                delete interest.reservations[reservation_id];
                
                var _cancelledReservations = db.child('cancelledReservations/');
                var cancelledReservation = {
                    reservingMember: reservingUser.memberNumber,
                    reservationMember: reservationUser.memberNumber,
                    sessionDate: session.date,
                    location: location.name
                };
                
                yield [_reservationUser.set(reservationUser), _reservingUser.set(reservingUser), _location.set(location), _interest.set(interest), _session.remove(), _reservation.remove(), _cancelledReservations.push(cancelledReservation)];
            }
            else if (verb === 'Reserve') {
                yield _reservation.set(reservation);
            }
        }).catch(onerror);
    }
};

function processCancellation(verb, db, context, _registration, registration, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    console.log("processCancellation");
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
                    if (validateCancellation(db, registeredUser, registration, event)) {
                        registration.status = "Cancelled";
                        if (!event.noRegistrationRequired) {
                            event.available = event.available + 1;
                        }
                        var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                        updateRegistration(db, _registration, registration, _event, event);
                        var details = yield buildConfirmation(verb,db, registeredUser, registration.registeredUser, event, registration, null, confirmation, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
                        //send each person on the confirmation their conf
                        if (details && event.sendAutoNotifications) {
                            yield sendConfirmation(db, registeredUser, registration.registeredUser, details, fromAddress);
                        }
                        
                        if (!primaryMemberConfirmation) { //now send one to the registering user also
                            details = yield buildConfirmation(verb, db, registeringUser, registration.registeringUser, event, registration, null, confirmation, totalCost, adultCount, juniorCount, true, templateBucket);
                            //send each person on the confirmation their conf
                            if (details && event.sendAutoNotifications) {
                                yield sendConfirmation(db, registeringUser, registration.registeringUser, details, fromAddress);
                            }
                        }
                        context.succeed({});
                    }
                    else {
                        updateRegistration(db, _registration, registration, _event, event);
                    }
                }).catch(onerror);
            }
        });
    }
};

function processModification(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlist(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlistModification(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};


function processRegistration(verb, db, context, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket) {
    console.log("processRegistration");
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
                    if (validateRegistration(db, registeredUser, registeringUser, registration, event)) {
                        registration.status = "Reserved";
                        if (!event.noRegistrationRequired) {
                            if (event.available > 0) {
                                event.available = event.available - 1;
                            }
                            else {
                                registration.Status = "Pending";
                                registration.isOnWaitlist = true;
                                verb = "Waitlist"; //change the verb so the correct template is sent out
                                if (event.creatingUser) {
                                    sendEventFull(db, event, fromAddress);
                                }
                            }
                        }
                        var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                        updateRegistration(db, _registration, registration, _event, event);
                        var details = yield buildConfirmation(verb, db, registeredUser, registration.registeredUser, event, registration, null, confirmation, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
                        //send each person on the confirmation their conf
                        if (details && event.sendAutoNotifications) {
                            yield sendConfirmation(db, registeredUser, registration.registeredUser, details, fromAddress);
                        }
                        
                        if (!primaryMemberConfirmation) { //now send one to the registering user also
                            details = yield buildConfirmation(verb, db, registeringUser, registration.registeringUser, event, registration, null, confirmation, totalCost, adultCount, juniorCount, true, templateBucket);
                            //send each person on the confirmation their conf
                            if (details && event.sendAutoNotifications) {
                                yield sendConfirmation(db, registeringUser, registration.registeringUser, details, fromAddress);
                            }
                        }
                        context.succeed({});
                    }
                    else {
                        updateRegistration(db, _registration, registration, _event, event);
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

function validateCancellation(db, user, registration, event) {
    if (!event)
        return false;
    if (!registration)
        return false;
    if (event.noRegistrationRequired)
        return true;
    
    if (!user) {
        registration.validationError = 'Registered user is invalid';
        return false;
    }
    
    if (registration.status === 'Billed') {
        registration.validationError = 'This registration has already been billed';
        return false;
    }
    
    if (registration.status === 'Cancelled') {
        return false;
    }
    
    if (event.cancelBy) {
        var threshold = moment(event.cancelBy);
        if (moment().isAfter(threshold)) {
            registration.validationError = 'Registration must be cancelled prior to '+threshold.format('MM/DD/YY @ h:mm A');
            return false;
        }
    }

    return true;
};

function validateReservation(db, reservationUser, reservingUser, reservation, location, interest, userReservationsForInterest, locationReservations, interestRule, locationRules) {
    if (!location)
        return false;
    if (!interest)
        return false;
    if (!reservation)
        return false;
    if (!reservationUser) {
        reservation.validationError = 'Reservation user is invalid';
        return false;
    }
    if (!reservingUser) {
        reservation.validationError = 'Reserving user is invalid';
        return false;
    }
    if (reservingUser.isAdmin || reservingUser.isDeptHead) { //no rule checks
        return true;
    }
    
    if (reservation.dateReserved) {
        var dateReserved = moment(reservation.dateReserved);
        var window = (interestRule.generalWindowLength || 0) + (interestRule.advancedWindowLength || 0);
        var dow = dateReserved.day();
        
    }

    return true;
};

function validateRegistration(db, user, registeringUser, registration, event) {
    if (!event)
        return false;
    if (!registration)
        return false;
    if (event.noRegistrationRequired)
        return true;
    
    if (!user) {
        registration.validationError = 'Registered user is invalid';
        return false;
    }
    
    if (!registeringUser) {
        registration.validationError = 'Registering user is invalid';
        return false;
    }
    
    if (registeringUser.isAdmin || registeringUser.isDeptHead) { //no rule checks
        return true;
    }
    
    if (registration.status === 'Billed') {
        registration.validationError = 'This registration has already been billed';
        return false;
    }
    
    if (registration.status === 'Cancelled') {
        registration.validationError = 'This registration has already been cancelled';
        return false;
    }
    
    if (registration.status === 'Reserved') { //already reserved?
        return false;
    }

    var dob = moment(user.dob);
    var isMale = false;
    if (user.gender === 'Male') {
        isMale = true;
    }
    if (!event.allowMales && isMale) {
        registration.validationError = 'Event does not allow males';
        return false;
    }
    if (!event.allowFemales && !isMale) {
        registration.validationError = 'Event does not allow females';
        return false;
    }
    if (!event.allowGuests && registration.isGuest) {
        registration.validationError = 'Event does not allow guests';
        return false;
    }
    if (!event.allowWaitlist) {
        if (event.available < 1) {
            registration.validationError = 'Event does not allow waitlisting, and no has no available capacity';
            return false;
        }
    }
    if (event.minAge) {
        var threshold = moment().subtract(event.minAge, 'years');
        if (dob.isAfter(threshold)) {
            registration.validationError = 'User is not old enough to register';
            return false;
        }
    }
    if (event.maxAge) {
        var threshold = moment().subtract(event.maxAge, 'years');
        if (dob.isBefore(threshold)) {
            registration.validationError = 'User is too old to register';
            return false;
        }
    }
    if (event.registrationOpen) {
        var threshold = moment(event.registrationOpen);
        if (moment().isBefore(threshold)) {
            registration.validationError = 'Event registration has not opened yet';
            return false;
        }
    }
    if (event.registrationClose) {
        var threshold = moment(event.registrationClose);
        if (moment().isAfter(threshold)) {
            registration.validationError = 'Event registration has already closed';
            return false;
        }
    }
    
    return true;
};

function updateRegistration(db, _registration, registration, _event, event) {
    co(function*() {
        yield _registration.set(registration);
        yield _event.set(event);
    }).catch(onerror);
};

function updateRegistration(db, _reservation, reservation) {
    co(function*() {
        yield _reservation.set(reservation);
    }).catch(onerror);
};

function sendConfirmation(db, user, user_id, details, fromAddress) {
    if (user && details && fromAddress) {
        console.log("sendConfirmation from" + fromAddress);
        return co(function*() {
            
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
                    from: fromAddress,
                    to: details.email,
                    subject: details.eventName,
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
        }).catch(onerror);
    }
};

function sendEventFull(db, event, fromAddress){
    return co(function*() {
        var _creatingUser = db.child('users/' + event.creatingUser);
        var creatingUser = yield _creatingUser.get();
        var message= event.allowWaitlist?event.name + ' has reached capacity and members are being waitlisted.':event.name + ' has reached capacity and members are no long able to register because the event does not allow waitlisting.'
    transporter.sendMail({
        from: fromAddress,
        to: creatingUser.email,
        subject: event.name+' is full',
        text: message
        }, function (error, info) {
            if (error) {
                console.log(error);
            }
            else if (info) {
                console.log(info);
            }
        });
    }).catch(onerror);
};

function buildConfirmation(verb, db, user, user_id, event, registration, reservation, confirmation, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket) {
    console.log("buildConfirmation");
    return co(function*() {
        var mark = require('markup-js');
        
        var template = null;
        if (confirmation) {
            if (verb === 'Register') {
                template = yield get(confirmation.confirmationTemplate);
            }
            else if (verb === 'Reserve') {
                template = yield get(confirmation.confirmationTemplate);
            }
            else if (verb === 'Cancel') {
                template = yield get(confirmation.cancellationTemplate);
            }
            else if (verb === 'Modify') {
                template = yield get(confirmation.modificationTemplate);
            }
            else if (verb === 'Waitlist') {
                template = yield get(confirmation.waitlistTemplate);
            }
            else if (verb === 'WaitlistModify') {
                template = yield get(confirmation.waitlistModificationTemplate);
            }
        } else {
            var templateName = "confirmation.html";
            if (verb === 'Cancel') {
                templateName = "cancellation.html";
            }
            else if (verb === 'Modify') {
                templateName = "modification.html";
            }
            else if (verb === 'Waitlist') {
                templateName = "waitlist.html";
            }
            else if (verb === 'WaitlistModify') {
                templateName = "waitlistmodification.html";
            }
            template=yield s3.getObject({
                Bucket: templateBucket, 
                Key: templateName
            });
        }
        
        var eventName = '';
        var eventNumber = '';
        var eventDate = '';
        var eventDescription = '';
        var cancelBy = '';
        var sessions = [];
        if (event) {
            cancelBy = moment(event.cancelBy).format('MMM at h:mm a');
            eventName = event.title;
            eventNumber = event.number;
            eventDate = moment(event.startDate).format('MMM');
            eventDescription = event.description;
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
        }
        
        var comments = '';
        if (registration) {
            comments = registration.comments;
        }
            
        if (reservation) {
            var _c = db.child('sessions/' + reservation.session);
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
        
        var details = {
            memberName: user.fullName,
            user_id: user_id,
            email: user.email,
            primaryMemberConfirmation: primaryMemberConfirmation,
            eventName: eventName,
            eventNumber: eventNumber,
            eventDate: eventDate,
            eventDescription: eventDescription,
            sessions: sessions,
            adultCount: adultCount,
            juniorCount: juniorCount,
            totalCost: totalCost,
            comments: comments,
            cancelBy: cancelBy
        };
        
        if (template) {
            var templateBody = template.Body.toString();
            details.content = mark.up(templateBody, details);
        }
        
        return details;
        
    }).catch(onerror);
};