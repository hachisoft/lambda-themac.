var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment');

var serverTimeOffset = 0;

var thunkify = require('thunkify');
var config = require('./config.js');

var S3 = require('./co-s3.js');
var ical = require('ical-generator');

var s3 = new S3();

var nodemailer = require('nodemailer');
var ses = require('nodemailer-ses-transport'); 


var transporter = nodemailer.createTransport(ses({
    region: 'us-west-2'
}));

if (config.verbose) {
    console.log('started confirm.js');
}

var fromAddress = null;

exports.handler = function (event, context) {
    var stage = event.stage || 'dev';
    var result = '';
    if (event && (event.registrations || event.reservation)) {
        if (config.verbose) {
            console.log(event);
            console.log(context);
        }
        
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
        
        if (config.verbose) {
            console.log(config);
            console.log('stage:' + stage);
        }
        
        NodeFire.setCacheSize(10);
        NodeFire.DEBUG = true;
        var db = new NodeFire(firebaseUrl);
        db.$firebase.child(".info/serverTimeOffset").on("value", function (snap) {
            serverTimeOffset = snap.val();
        });
        db.auth(authToken).then(function () {
            if (config.verbose) {
                console.log('Auth succeeded');
            }
            if (event.reservation) {
                var _reservation = db.child('reservations/' + event.reservation);
                co(function*() {
                    var reservation = yield _reservation.get();
                    
                        if (event.verb === 'Reserve') {
                            yield processReservation(event.verb, db, context, _reservation, reservation, event.reservation, fromAddress, templateBucket);
                        }
                        else if (event.verb === 'Cancel') {
                            yield processReservationCancel(event.verb, db, context, _reservation, reservation, event.reservation, fromAddress, templateBucket);
                        }
                        context.succeed({});
                    
                }).catch(onerror);
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
                        _registrations.push(event.registrations[i]);
                        promises.push(_registration.get());
                    }
                }
                co(function*() {
                    var registrations = yield promises;
                    for (var k = 0; k < registrations.length; k++) {
                        var registration = registrations[k];
                        var registration_id = _registrations[k];
                        var _registration = db.child('registrations/' + registration_id);
                        if (registration) {
                            if (event.verb === "Register" && registration.status === "Pending") {
                                noneMatched = false;
                                yield processRegistration(event.verb, db, context, registration_id, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket);
                            }
                            else if (event.verb === "Cancel") {
                                noneMatched = false;
                                yield processRegistrationCancellation(event.verb,db, context, registration_id, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (event.verb === "Modify" && registration.status === "Reserved") {
                                noneMatched = false;
                                yield processModification(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (event.verb === "Waitlist" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                yield processWaitlist(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (event.verb === "WaitlistModify" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                yield processWaitlistModify(event.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                        }
                    }
                    if (noneMatched) {
                        if (config.verbose) {
                            console.log("No registrations matched the desired status");
                        }
                        context.succeed(
                            {
                                result: "No registrations matched the desired status",
                                verb: event.verb
                            });
                    }
                    else {
                        context.succeed({});
                    }
                }).catch(onerror);
            }
        });
    }
    else {
        if (config.verbose) {
            console.log('No event object');
        }
        context.fail();
    }
};

function formatTime(epoch, fmt)
{
    return moment(epoch).utcOffset(-8).format(fmt);
}

function processReservation(verb, db, context, _reservation, reservation, reservation_id, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    if (config.verbose) { console.log("processReservation"); }
    return co(function*() {
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
                yield updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
                var details = yield buildConfirmation(verb, db, reservationUser, reservation.reservationUser, null, null, reservation, null, location.name, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
                //send each person on the confirmation their conf
                if (details) {
                    yield sendConfirmation(db, reservationUser, reservation.reservationUser, details, fromAddress);
                }
                
                if (!primaryMemberConfirmation) { //now send one to the reserving user also
                    details = yield buildConfirmation(verb, db, reservingUser, reservation.reservingUser, null, null, reservation, null, location.name, totalCost, adultCount, juniorCount, true, templateBucket);
                    //send each person on the confirmation their conf
                    if (details) {
                        yield sendConfirmation(db, reservingUser, reservation.reservingUser, details, fromAddress);
                    }
                }
            }
            else {
                yield updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
            }
        }
    }).catch(onerror);
};

function processReservationCancel(verb, db, context, _reservation, reservation, reservation_id, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    if (config.verbose) {
        console.log("processReservationCancel");
        console.log(reservation);
    }
    return co(function*() {
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
            yield updateReservation(verb, db, _reservation, reservation,reservation_id, _session,session,_location,location,_reservationUser,reservationUser,_reservingUser,reservingUser,_interest,interest);
            var details = yield buildConfirmation(verb, db, reservationUser, reservation.reservationUser, null, null, reservation, null, location.name, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
            //send each person on the confirmation their conf
            if (details) {
                yield sendConfirmation(db, reservationUser, reservation.reservationUser, details, fromAddress);
            }
                
            if (!primaryMemberConfirmation) { //now send one to the reserving user also
                details = yield buildConfirmation(verb, db, reservingUser, reservation.reservingUser, null, null, reservation, null, location.name, totalCost, adultCount, juniorCount, true, templateBucket);
                //send each person on the confirmation their conf
                if (details) {
                    yield sendConfirmation(db, reservingUser, reservation.reservingUser, details, fromAddress);
                }
            }
            
        }
    }).catch(onerror);
};

function updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest) {
    return co(function*() {
        if (config.verbose) {
            console.log("updateReservation verb:" + verb);
        }
        if (verb === 'Cancel') {
            var promises = [];
                
            if (reservationUser && reservationUser.reservations) {
                if (config.verbose) {
                    console.log('reservationUser');
                }
                delete reservationUser.reservations[reservation_id];
                promises.push(_reservationUser.set(reservationUser));

            }
                
            if (reservingUser && reservingUser.createdReservations) {
                if (config.verbose) {
                    console.log('reservingUser');
                }
                delete reservingUser.createdReservations[reservation_id];
                promises.push(_reservingUser.set(reservingUser));
            }
                
            if (location) {
                if (config.verbose) {
                    console.log('location');
                }
                if (location.reservations) {
                    delete location.reservations[reservation_id];
                }
                if (location.sessions && reservation.session) {
                    delete location.sessions[reservation.session];
                }
                promises.push(_location.set(location));  
            }
                
            if (interest) {
                if (config.verbose) {
                    console.log('interest');
                }
                delete interest.reservations[reservation_id];
                promises.push(_interest.set(interest));
            }
                
            if (location && session && reservingUser && reservationUser && interest) {
                if (config.verbose) {
                    console.log('cancelledReservations');
                }
                var _cancelledReservations = db.child('cancelledReservations/');
                var cancelledReservation = {
                    reservingMember: reservingUser.memberNumber,
                    reservationMember: reservationUser.memberNumber,
                    sessionDate: session.date,
                    location: location.name,
                    interest: interest.name
                };
                promises.push(_cancelledReservations.push(cancelledReservation));
            }
                
            if (_session) {
                if (config.verbose) {
                    console.log('_session');
                }
                promises.push(_session.remove());
            }
                
            if (_reservation) {
                if (config.verbose) {
                    console.log('_reservation');
                }
                promises.push(_reservation.remove());
            }
            yield promises;
        }
        else if (verb === 'Reserve') {
            yield _reservation.set(reservation);
        }
    }).catch(onerror);
};

function processRegistrationCancellation(verb, db, context, registration_id, _registration, registration, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    if (config.verbose) {
        console.log("processRegistrationCancellation");
    }
    return co(function*() {
        var _event = db.child('events/' + registration.event);
        var event = yield _event.get();
        if (event) {
            var _confirmation = null;
            if (event.confirmation)
                _confirmation = db.child('confirmations/' + event.confirmation);
            var _registeredUser = db.child('users/' + registration.registeredUser);
            var _registeringUser = db.child('users/' + registration.registeringUser);
            var _fee = db.child('fees/' + registration.fee);
            
            var confirmation = null;
            if (_confirmation)
                confirmation = yield _confirmation.get();
            var registeredUser = yield _registeredUser.get();
            var registeringUser = yield _registeringUser.get();
            var fee = yield _fee.get();
            if (validateCancellation(db, registeredUser, registration, event, fee)) {
                registration.status = "Cancelled";
                if (!event.noRegistrationRequired) {
                    event.available = event.available + 1;
                }
                var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                yield updateRegistration(verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
                var details = yield buildConfirmation(verb, db, registeredUser, registration.registeredUser, event, registration, null, confirmation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
                //send each person on the confirmation their conf
                if (details && event.sendAutoNotifications) {
                    yield sendConfirmation(db, registeredUser, registration.registeredUser, details, fromAddress);
                }
                
                if (!primaryMemberConfirmation) { //now send one to the registering user also
                    details = yield buildConfirmation(verb, db, registeringUser, registration.registeringUser, event, registration, null, confirmation, null, totalCost, adultCount, juniorCount, true, templateBucket);
                    //send each person on the confirmation their conf
                    if (details && event.sendAutoNotifications) {
                        yield sendConfirmation(db, registeringUser, registration.registeringUser, details, fromAddress);
                    }
                }
            }
            else {
                yield updateRegistration(verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
            }
        }
    }).catch(onerror);
};

function processModification(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlist(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlistModification(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};


function processRegistration(verb, db, context, registration_id, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket) {
    if (config.verbose) { console.log("processRegistration"); }
    var _event = db.child('events/' + registration.event);
    if (_event) {
        return _event.get().then(function (event) {
            console.log(event);
            if (event) {
                var _confirmation = null;
                if (event.confirmation)
                    _confirmation = db.child('confirmations/' + event.confirmation);
                var _registeredUser = db.child('users/' + registration.registeredUser);
                var _registeringUser = db.child('users/' + registration.registeringUser);
                var _fee = db.child('fees/' + registration.fee);
                return co(function*() {
                    var confirmation = null;
                    if (_confirmation)
                        confirmation = yield _confirmation.get();
                    var registeredUser = yield _registeredUser.get();
                    var registeringUser = yield _registeringUser.get();
                    var fee = yield _fee.get();
                    if (validateRegistration(db, registeredUser, registeringUser, registration, event)) {
                        registration.status = "Reserved";
                        registration.dateRegistered = moment().valueOf();
                        if (!event.noRegistrationRequired) {
                            if (event.available > 0) {
                                event.available = event.available - 1;
                            }
                            else {
                                registration.status = "Pending";
                                registration.isOnWaitlist = true;
                                verb = "Waitlist"; //change the verb so the correct template is sent out
                                if (event.creatingUser) {
                                    yield sendEventFull(db, event, fromAddress);
                                }
                            }
                        }
                        var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                        yield updateRegistration(verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
                        var details = yield buildConfirmation(verb, db, registeredUser, registration.registeredUser, event, registration, null, confirmation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket);
                        //send each person on the confirmation their conf
                        if (details && event.sendAutoNotifications) {
                            yield sendConfirmation(db, registeredUser, registration.registeredUser, details, fromAddress);
                        }
                        
                        if (!primaryMemberConfirmation) { //now send one to the registering user also
                            details = yield buildConfirmation(verb, db, registeringUser, registration.registeringUser, event, registration, null, confirmation, null, totalCost, adultCount, juniorCount, true, templateBucket);
                            //send each person on the confirmation their conf
                            if (details && event.sendAutoNotifications) {
                                yield sendConfirmation(db, registeringUser, registration.registeringUser, details, fromAddress);
                            }
                        }
                    }
                    else {
                        yield updateRegistration(verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
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
    console.error(err);
}

function validateCancellation(db, user, registration, event, fee) {
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
            registration.validationError = 'Registration must be cancelled prior to '+ formatTime(event.cancelBy,'MM/DD/YY @ h:mm A');
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

function updateRegistration(verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee) {
    if (config.verbose) {
        console.log('updateRegistration:'+verb);
    }
    return co(function*() {
        if (verb === 'Cancel') {
            if (registration) {
                var promises = [];
                var locationName = null;
                var interestName = null;
                //this will delete the registration from associated models and add a new item to cancelledRegistrations
                if (registration.registeringUser) {
                    if (registeringUser && registeringUser.createdRegistrations) {
                        delete registeringUser.createdRegistrations[registration_id];
                        promises.push(_registeringUser.set(registeringUser));
                    }
                }
                if (registration.registeredUser) {
                    if (registeredUser && registeredUser.registrations) {
                        delete registeredUser.registrations[registration_id];
                        promises.push(_registeredUser.set(registeredUser));
                    }
                }
                if (registration.fee) {
                    if (fee && fee.registrations) {
                        delete fee.registrations[registration_id];
                        promises.push(_fee.set(fee));
                    }
                }
                if (registration.event) {
                    if (event){
                        if (event.registrations) {
                            delete event.registrations[registration_id];
                            promises.push(_event.set(event));
                        }
                        if (event.interest) {
                            var _interest = db.child('interests/' + event.interest);
                            var interest = yield _interest.get();
                            if (interest) {
                                interestName = interest.name;
                            }
                        }

                        if (event.location) {
                            var _location = db.child('locations/' + event.location);
                            var location = yield _location.get();
                            if (location) {
                                locationName = location.name;
                            }
                        }
                    }
                }
                
                promises.push(_registration.remove());

                if (registeredUser && registeringUser && event) {
                    if (config.verbose) {
                        console.log('added cancelledRegistrations');
                    }
                    var _cancelledRegistrations = db.child('cancelledRegistrations/');
                    var cancelledRegistration = {
                        registeredMember: registeredUser.memberNumber,
                        registeringMember: registeringUser.memberNumber,
                        event: event.number,
                        startDate: event.startDate,
                        endDate: event.endDate,
                        location: locationName,
                        interest: interestName
                    };
                    promises.push(_cancelledRegistrations.push(cancelledRegistration));
                }

                yield promises;
            }
        }
        else if (verb === 'Register' || verb === 'Waitlist') {
            yield _event.set(event);
            yield _registration.set(registration);
        }
    }).catch(onerror);
};

function sendEmail(fromAddress, to, subject, content,message,attachment) {
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

function sendConfirmation(db, user, user_id, details, fromAddress) {
    if (user && details && fromAddress) {
        if (config.verbose) { console.log("sendConfirmation from " + fromAddress+" to "+user.email); }
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
                yield sendEmail(fromAddress, details.email, details.eventName, details.content,null,details.attachment);
            }
        }).catch(onerror);
    }
};

function sendEventFull(db, event, fromAddress){
    return co(function*() {
        var _creatingUser = db.child('users/' + event.creatingUser);
        var creatingUser = yield _creatingUser.get();
        var eventName = event.title || '';
        var eventNumber = event.number || '';
        var message = '';
        if (event.allowWaitlist) {
            message = eventNumber + '\n';
            message += eventName + ' has reached its capacity of ' + event.capacity + '.\n';
            message += 'Members are being waitlisted.';
        }
        else {
            message = eventNumber + '\n';
            message += eventName + ' has reached its capacity of ' + event.capacity + '.\n';
            message += 'Members are no longer able to register because the event does not allow waitlisting.';
        }
        yield sendEmail(fromAddress, creatingUser.email, eventName + ' is full', null, message, null);
    }).catch(onerror);
};

function download(url) {
    // Return a new promise.
    return new Promise(function (resolve, reject) {
        // Do the usual XHR stuff
        var req = new XMLHttpRequest();
        req.open('GET', url);
        
        req.onload = function () {
            // This is called even on 404 etc
            // so check the status
            if (req.status == 200) {
                // Resolve the promise with the response text
                resolve(req.response);
            }
            else {
                // Otherwise reject with the status text
                // which will hopefully be a meaningful error
                reject(Error(req.statusText));
            }
        };
        
        // Handle network errors
        req.onerror = function () {
            reject(Error("Network Error"));
        };
        
        // Make the request
        req.send();
    });
}

function buildConfirmation(verb, db, user, user_id, event, registration, reservation, confirmation, location, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket) {
    if (config.verbose) {
        console.log("buildConfirmation");
    }
    return co(function*() {
        var mark = require('markup-js');
        
        var template = null;
        if (confirmation) {
            if (verb === 'Register') {
                template = yield download(confirmation.confirmationTemplate);
            }
            else if (verb === 'Reserve') {
                template = yield download(confirmation.confirmationTemplate);
            }
            else if (verb === 'Cancel') {
                template = yield download(confirmation.cancellationTemplate);
            }
            else if (verb === 'Modify') {
                template = yield download(confirmation.modificationTemplate);
            }
            else if (verb === 'Waitlist') {
                template = yield download(confirmation.waitlistTemplate);
            }
            else if (verb === 'WaitlistModify') {
                template = yield download(confirmation.waitlistModificationTemplate);
            }
        } else {
            var templateName = "confirmation.html";
            if (verb === 'Cancel') {
                templateName = "cancellation.html";
                if (reservation) {
                    templateName = "reservation_cancellation.html";
                }
            }
            else if (verb === 'Reserve') {
                templateName = "reservation_confirmation.html";
            }
            else if (verb === 'Modify') {
                templateName = "modification.html";
                if (reservation) {
                    templateName = "reservation_modification.html";
                }
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
        if (config.verbose) {
            console.log('Template Name: ' + templateName);
        }
        
        var cal = null;
        if (verb === 'Register') {
            cal = ical();
            cal.prodId({
                company: 'MAC',
                product: 'ics',
                language: 'EN' 
            });
        }
        if (cal) {
            cal.setDomain('http://www.themac.com');
        }
        var eventName = '';
        var eventNumber = '';
        var eventDate = '';
        var eventDescription = '';
        var cancelBy = '';
        var reservationDate = '';
        var reservationStartTime = '';
        var sessions = [];
        if (event) {
            cancelBy = formatTime(event.cancelBy,'MMM Do h:mm a');
            eventName = event.title;
            eventNumber = event.number;
            
            if (cal) {
                cal.setName(eventName);
            }

            eventDate = formatTime(event.startDate,'MMM Do');
            eventDescription = event.description;
            if (event.sessions) {
                for (var propertyName in event.sessions) {
                    var _c = db.child('sessions/' + propertyName);
                    var session = yield _c.get();
                    if (session) {
                        var sessionLocationName = '';
                        if (session.location) {
                            var _sl = db.child('locations/' + session.location)
                            var sl = yield sl.get();
                            if (sl) {
                                sessionLocationName = sl.name || '';
                            }
                        }
                        if (cal) {
                            var ce=cal.createEvent({
                                start: moment(session.date).toDate(),
                                end: moment(session.date + (session.duration * 60000)).toDate(),
                                summary: eventName,
                                description: eventDescription,
                                location: sessionLocationName,
                                method: 'publish'
                            });
                            if (ce) {
                                ce.createAttendee({
                                    email: user.email,
                                    name: user.name
                                });
                                ce.organizer({
                                    name: 'The MAC',
                                    email: fromAddress
                                });
                            }
                        }
                        sessions.push({
                            date: formatTime(session.date,'MMM Do'),
                            startTime: formatTime(session.date,'h:mm a'),
                            endTime: formatTime(session.date + (session.duration * 60000),'h:mm a'),
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
                reservationDate = formatTime(session.date,'MMM Do');
                reservationStartTime = formatTime(session.date,'h:mm a');
            }
        }
        var attachment = null;
        if (cal) {
            attachment = {
                content:cal.toString(),
                filename:eventName+'.ics'
            };
            cal?cal.toString():null
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
            cancelBy: cancelBy,
            reservationDate: reservationDate,
            reservationStartTime: reservationStartTime,
            location: location,
            attachment: attachment
        };
        
        if (config.verbose) {
            console.log(details);
        }
        
        if (template) {
            var templateBody = template.Body.toString();
            details.content = mark.up(templateBody, details);
        }
        
        return details;
        
    }).catch(onerror);
};