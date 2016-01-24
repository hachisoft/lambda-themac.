﻿var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment');
var momentRange = require('moment-range');
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

var errors = [];
var fromAddress = null;

exports.handler = function (params, context) {
    var stage = params.stage || 'dev';
    var result = '';
    if (params && (params.registrations || params.reservation || params.event)) {
        if (config.verbose) {
            console.log(params);
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
            if (params.reservation) {
                var _reservation = db.child('reservations/' + params.reservation);
                co(function*() {
                    var reservation = yield _reservation.get();
                    if (reservation) {
                        if (params.verb === 'Reserve' && reservation.status === 'Pending') {
                            yield processReservation(params.verb, db, context, _reservation, reservation, params.reservation, fromAddress, templateBucket);
                        }
                        else if (params.verb === 'Cancel') {
                            yield processReservationCancel(params.verb, db, context, _reservation, reservation, params.reservation, fromAddress, templateBucket);
                        }
                    }
                    if (errors.length > 0) {
                        context.fail(JSON.stringify(errors));
                    }
                    else {
                        context.succeed({});
                    }
                    
                }).catch(onerror);
            }
            else if (params.event) {
                var _event = db.child('events/' + params.event);
                var _cancellingUser = db.child('users/' + params.cancellingUser);
                co(function*() {
                    var event = yield _event.get();
                    var cancellingUser = yield _cancellingUser.get();
                    if (event && params.verb === 'CancelEvent') {
                        yield processEventCancel(params.verb, db, context, _event, event, params.event, cancellingUser, params.cancellingUser, fromAddress, templateBucket);
                    }
                    if (errors.length > 0) {
                        context.fail(JSON.stringify(errors));
                    }
                    else {
                        context.succeed({});
                    }
                    
                }).catch(onerror);
            }
            else {
                var totalCost = params.totalCost || null;
                var adultCount = params.adultCount || null;
                var juniorCount = params.juniorCount || null;
                
                var noneMatched = true;
                var promises = [];
                var _registrations = [];
                for (var i = 0; i < params.registrations.length; i++) {
                    var _registration = db.child('registrations/' + params.registrations[i]);
                    if (_registration) {
                        _registrations.push(params.registrations[i]);
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
                            if (params.verb === "Register") {
                                if (registration.status === "Pending") {
                                    noneMatched = false;
                                    yield processRegistration(params.verb, db, context, registration_id, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket);
                                }
                                else if (registration.status === "Wishlist") {
                                    noneMatched = false;
                                    yield processWishlist(db, context, registration);
                                }
                            }
                            else if (params.verb === "Cancel" || params.verb === "CancelEvent") {
                                noneMatched = false;
                                yield processRegistrationCancellation(params.verb,db, context, registration_id, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (params.verb === "Modify" && registration.status === "Reserved") {
                                noneMatched = false;
                                yield processModification(params.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (params.verb === "Waitlist" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                yield processWaitlist(params.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (params.verb === "WaitlistModify" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                yield processWaitlistModify(params.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                        }
                    }
                    if (errors.length > 0) {
                        context.fail(JSON.stringify(errors));
                    }
                    else if (noneMatched) {
                        context.fail('No registrations matched');
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

function formatRange(range, fmt)
{
    var from = formatTime(range.start, fmt);
    var to = formatTime(range.end, fmt);
    return from + ' - ' + to;
}

function processWishlist(db, context, registration)
{
    return co(function*() {
        if (registration.registeringUser) {
            var _user = db.child('users/' + registration.registeringUser);
            var user = yield _user.get();
            if (user) {
                if (user.numWishlist) {
                    user.numWishlist++;
                }
                else {
                    user.numWishlist = 1;
                }
                _user.set(user);
            }
        }
    }).catch(onerror);
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
            var urfiKeys = Object.keys(_urfi);
            for (var w = 0; w < urfiKeys.length; w++) {
                var key = urfiKeys[w];
                if (key != reservation_id) {
                    if (_urfi[key].interest === reservation.interest) {
                        var urfi = _urfi [key];
                        var _urfiSession = db.child('sessions/' + urfi.session);
                        var urfiSession = yield _urfiSession.get();
                        if (urfiSession) {
                            userReservationsForInterest.push({
                                'id': key,
                                'value': urfi,
                                'session': urfiSession
                            });
                        }
                    }
                }
            }
        }
        if (_lr) {
            var lrKeys = Object.keys(_lr);
            for (var t = 0; t < lrKeys.length; t++) {
                var key = lrKeys[t];
                var lr = _lr[key];
                var _lrSession = db.child('sessions/' + lr.session);
                var lrSession = yield _lrSession.get();
                if (lrSession) {
                    locationReservations.push({
                        'id': key,
                        'value': lr,
                        'session': lrSession
                    });
                }
            }
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
            if (validateReservation(db, reservationUser, reservingUser, reservation, reservation_id, location, interest, userReservationsForInterest, locationReservations, reservationRule, rules, session)) {
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
                reservation.isAdvRes = false;
                yield updateReservation('Error-Reserve', db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
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
            if (validateReservationCancel(session,reservation,location,interest,reservingUser,reservationUser,reservation)) {
                reservation.status = "Cancelled";
                
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
                yield updateReservation('Error-Cancel', db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
            }
        }
    }).catch(onerror);
};

function validateReservationCancel(session, reservation, location, interest, reservingUser, reservationUser, reservation)
{
    return true;
}

function updateReservation(verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest) {
    return co(function*() {
        var promises = [];
        var _auditReservations = db.child('auditReservations')    
        var auditEntry = {
            'verb': verb,
            'timestamp': moment().valueOf()
        };
        if (config.verbose) {
            console.log("updateReservation verb:" + verb);
        }
        if (verb === 'Cancel') {
            
            if (reservationUser && reservationUser.reservations) {
                if (reservationUser.memberNumber) {
                    auditEntry.reservedMember = reservationUser.memberNumber
                }
                
                delete reservationUser.reservations[reservation_id];
                promises.push(_reservationUser.set(reservationUser));

            }
                
            if (reservingUser && reservingUser.createdReservations) {
                if (reservingUser.memberNumber) {
                    auditEntry.reservingMember = reservingUser.memberNumber
                }
                
                delete reservingUser.createdReservations[reservation_id];
                promises.push(_reservingUser.set(reservingUser));
            }
                
            if (location) {
                if (location.name) {
                    auditEntry.location = location.name
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
                if (interest.name) {
                    auditEntry.interest = interest.name
                }
                delete interest.reservations[reservation_id];
                promises.push(_interest.set(interest));
            }
                
            if (location && session && reservingUser && reservationUser && interest) {
                if (session.date) {
                    auditEntry.date = session.date
                }
                if (session.endDate) {
                    auditEntry.endDate = session.endDate
                }
                var _cancelledReservations = db.child('cancelledReservations/');
                var cancelledReservation = {
                    reservingMember: reservingUser.memberNumber || '',
                    reservationMember: reservationUser.memberNumber|| '',
                    sessionDate: session.date || moment().valueOf(),
                    location: location.name || '',
                    interest: interest.name || ''
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
            
        }
        else if (verb === 'Reserve' || verb === 'Error-Reserve' || verb === 'Error-Cancel') //reserve and error just update the reservation
        {
            if (reservationUser && reservationUser.memberNumber) {
                auditEntry.reservedMember = reservationUser.memberNumber
            }
            
            if (reservingUser && reservingUser.memberNumber) {
                auditEntry.reservingMember = reservingUser.memberNumber
            }
                
            if (location && location.name) {
                auditEntry.location = location.name
            }
                
            if (interest && interest.name) {
                auditEntry.interest = interest.name
            }
                
            if (session) {
                if (session.date) {
                    auditEntry.date = session.date
                }
                if (session.endDate) {
                    auditEntry.endDate = session.endDate
                }
            }
            promises.push(_reservation.set(reservation));
        }
        promises.push(_auditReservations.set(auditEntry));
        yield promises;
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
                yield updateRegistration('Error-Cancel', db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
            }
        }
    }).catch(onerror);
};

function processEventCancel(verb, db, context, _event, event, event_id, cancellingUser, cancellingUser_id, fromAddress, templateBucket) {
    if (config.verbose) {
        console.log("processEventCancellation");
    }
    return co(function*() {
        if (validateEventCancellation(db, cancellingUser, event)) {
            var eventName = event.title || '';
            var eventNumber = event.number || '';
            var message =  eventNumber + '\n';
            message += eventName + ' has been cancelled.\n';
            if (cancellingUser && cancellingUser.email) {
                yield sendEmail(fromAddress, cancellingUser.email, eventName + ' is cancelled', null, message, null);
            }
            yield archiveAndDeleteEvent(db, _event, event, event_id, cancellingUser);
        }
    }).catch(onerror);
};

function validateEventCancellation(db, cancellingUser, event)
{
    if (cancellingUser) {
        if (cancellingUser.isAdmin || cancellingUser.isDeptHead) {
            return true;
        }
    }
    return false;
}

function archiveAndDeleteEvent(db, _event, event, event_id, cancellingUser)
{
    if (config.verbose) {
        console.log("archiveAndDeleteEvent");
    }
    return co(function*() {
        var promises = [];
        var _cancelledEvent = db.child('cancelledEvents/' + event_id);
        var cancelledEvent = {
            'number': event.number || '',
            'title': event.title || '',
            'description': event.description || '',
            'staffNotes': event.staffNotes || '',
            'capacity': event.capacity || 0,
            'available': event.available || 0,
            'defaultInstructor': event.defaultInstructor || '',
            'allowRapidRegistration': event.allowRapidRegistration || false,
            'allowMales': event.allowMales || true,
            'allowFemales': event.allowFemales || true,
            'allowWaitlist': event.allowWaitlist || true,
            'allowGuest': event.allowGuest || false,
            'noRegistrationRequired': event.noRegistrationRequired || false,
            'displayRoster': event.displayRoster || false,
            'sendAutoNotifications': event.sendAutoNotifications || false,
            'minAge': event.minAge || 0,
            'maxAge': event.maxAge || 199,
            'registrationCapacity': event.registrationCapacity || 1,
            'registrationOpen': event.registrationOpen || moment(0).valueOf(),
            'registrationClose': event.registrationClose || moment(0).valueOf(),
            'cancelBy': event.cancelBy || moment().valueOf(),
            'startDate': event.startDate || moment().valueOf(),
            'endDate': event.endDate || moment().valueOf(),
            'timestamp': event.timestamp || moment().valueOf(),
            'daysOfWeek': event.daysOfWeek || 0,
            'status': event.status || 'Cancelled',
            'video': event.video || '',
            'image': event.image || '',
            'largest': event.largest || '',
            'larger': event.larger || '',
            'large': event.large || '',
            'medium': event.medium || '',
            'small': event.small || ''
        };
        
        if (event.billedDate)
            cancelledEvent.billedDate = event.billedDate;
        if (cancellingUser) {
            cancelledEvent.cancellingMember = cancellingUser.memberNumber;
        }
        
        if (event.interests) {
            cancelledEvent.interests = {};
            var interestPromises = [];
            var _interests = [];
            Object.keys(event.interests).forEach(function (key) {
                var _interest = db.child('interests/' + key);
                interestPromises.push(_interest.get());
                _interests.push({
                    'id': key,
                    'ref': _interest
                });
            });
            
            var interests = yield interestPromises;
            if (interests) {
                for (var k = 0; k < interests.length; k++) {
                    var _interest = _interests[k].ref;
                    var interest = interests[k];
                    if (interest && interest.events) {
                        cancelledEvent.interests[interest.name] = 'true';
                        delete interest.events[event_id];
                        promises.push(_interest.set(interest));
                    }
                }
            }
        }

        if (event.survey) {
            cancelledEvent.survey = {};
            var _survey = db.child('surveys/' + event.survey);
            var survey = yield _survey.get();
            if (survey && survey.event) {
                if (survey.surveyItems) {
                    Object.keys(survey.surveyItems).forEach(function (key) {
                        var _si = db.child('surveyItems/' + key);
                        promises.push(_si.remove());
                    });
                }
                if (survey.responses) {
                    Object.keys(survey.responses).forEach(function (key) {
                        var _sr = db.child('surveyResponses/' + key);
                        promises.push(_sr.remove());
                    });
                }
                promises.push(_survey.remove());
            }
        }

        if (event.fees) { //one fee per event; event can have many fees
            cancelledEvent.fees = {};
            var feePromises = [];
            var _fees = [];
            Object.keys(event.fees).forEach(function (key) {
                var _fee = db.child('fees/' + key);
                feePromises.push(_fee.get());
                _fees.push({
                    'id': key,
                    'ref':_fee
                });
            });
            
            var fees = yield feePromises;
            if (fees) {
                for (var k = 0; k < fees.length; k++) {
                    var _fee = _fees[k];
                    var fee = fees[k];
                    if (fee) {
                        cancelledEvent.fees[_fee.id] = {
                            'type': fee.type || '',
                            'amount': fee.amount || 0,
                            'minAge': fee.minAge || 0,
                            'maxAge': fee.maxAge || 199,
                            'GLNumber': fee.GLNumber || '',
                            'GLTitle': fee.GLTitle || '',
                            'cancellationAmount': fee.cancellationAmount || 0,
                            'noShowAmount': fee.noShowAmount || 0,
                            'description': fee.description || ''
                        };
                        if (fee.template) {
                            var _template = db.child('pricingTemplate/' + fee.template);
                            var template = yield _template.get();
                            if (template) {
                               
                                delete template.fees[_fee.id];
                                promises.push(_template.set(template));
                            }
                        }
                    }
                    promises.push(_fee.ref.remove());
                }
            }
        }

        if (event.registrations) { 
            var registrationPromises = [];
            var _registrations = [];
            Object.keys(event.registrations).forEach(function (key) {
                var _registration = db.child('registrations/' + key);
                registrationPromises.push(_registration.get());
                _registrations.push({
                    'id': key,
                    'ref': _registration
                });
            });
            
            var registrations = yield registrationPromises;
            if (registrations) {
                yield deleteRegistrations(db, registrations, _registrations, cancelledEvent, false, false);
            }
        }
        
        if (event.sessions) {
            var sessionPromises = [];
            var _sessions = [];
            Object.keys(event.sessions).forEach(function (key) {
                var _session = db.child('sessions/' + key);
                sessionPromises.push(_session.get());
                _sessions.push({
                    'id': key,
                    'ref': _session
                });
            });
            
            var sessions = yield sessionPromises;
            if (sessions) {
                yield deleteSessions(db, sessions, _sessions);
            }
        }

        if (event.confirmation) {
            var _confirmation = db.child('confirmations/' + event.confirmation);
            promises.push(_confirmation.remove());
        }

        promises.push(_cancelledEvent.set(cancelledEvent));
        promises.push(_event.remove());
        return yield promises;
    }).catch(onerror);
}

function deleteSessions(db, sessions, _sessions) {
    return co(function*() {
        var promises = [];
        for (var k = 0; k < sessions.length; k++) {
            var session = sessions[k];
            var session_id = _sessions[k].id;
            var _session = _sessions[k].ref;
            if (session) {
                if (session.location) {
                    var _location = db.child('locations/' + session.location);
                    var location = yield _location.get();
                    if (location && location.sessions) {
                        delete location.sessions[session_id];
                        promises.push(_location.set(location));
                    }
                }
                if (session.reservation) {
                    var _reservation = db.child('reservations/' + session.reservation);
                    var reservation = yield _reservation.get();
                    if (reservation && reservation.session) {
                        //not currently supported
                    }
                }
                if (session.closure) {
                    var _closure = db.child('closures/' + session.closure);
                    var closure = yield _closure.get();
                    if (closure && _closure.session) {
                        //not currently supported
                    }
                }
                
                promises.push(_session.remove());
            }
        }
        return yield promises;
    }).catch(onerror);
}

function deleteRegistrations(db, registrations, _registrations, cancelledEvent, deleteFee, deleteEvent)
{
    return co(function*() {
        if (cancelledEvent) {
            cancelledEvent.registrations = {};
        }
        var promises = [];
        for (var k = 0; k < registrations.length; k++) {
            var registration = registrations[k];
            var _registration = _registrations[k].ref;
            var registration_id = _registrations[k].id;
            
            if (registration) {
                if (cancelledEvent) {
                    cancelledEvent.registrations[registration_id] = {
                        'firstName': registration.firstName || '',
                        'lastName': registration.lastName || '',
                        'dateRegistered': registration.dateRegistered || moment().valueOf(),
                        'memberNumber': registration.memberNumber || '',
                        'isGuest': registration.isGuest || false,
                        'isJunior': registration.isJunior || false,
                        'isOnWaitlist': registration.isOnWaitlist || false,
                        'attendanceCount': registration.attendanceCount || 0,
                        'isNoShow': registration.isNoShow || false,
                        'status': registration.status || 'Cancelled',
                        'group': registration.group || '',
                        'validationError': registration.validationError || ''
                    };

                    if (registration.billingDate) {
                        cancelledEvent.registrations[registration_id].billingDate = registration.billingDate;
                    }
                    if (registration.feeOverride) {
                        cancelledEvent.registrations[registration_id].feeOverride = registration.feeOverride;
                    }
                }
                if (registration.registeringUser) {
                    var _registeringUser = db.child('users/' + registration.registeringUser);
                    var registeringUser = yield _registeringUser.get();
                    if (registeringUser && registeringUser.createdRegistrations) {
                        if (cancelledEvent) {
                            cancelledEvent.registrations[registration_id].registeringMember = registeringUser.memberNumber;
                        }
                        delete registeringUser.createdRegistrations[registration_id];
                        promises.push(_registeringUser.set(registeringUser));
                    }
                }
                if (registration.registeredUser) {
                    var _registeredUser = db.child('users/' + registration.registeredUser);
                    var registeredUser = yield _registeredUser.get();
                    if (registeredUser && registeredUser.registrations) {
                        if (cancelledEvent) {
                            cancelledEvent.registrations[registration_id].registeredMember = registeredUser.memberNumber;
                        }
                        delete registeredUser.registrations[registration_id];
                        promises.push(_registeredUser.set(registeredUser));
                    }
                }
                if (registration.fee && deleteFee) {
                    var _fee = db.child('fees/' + registration.fee);
                    var fee = yield _fee.get();
                    if (fee && fee.registrations) {
                        if (cancelledEvent) {
                            cancelledEvent.registrations[registration_id].fee = fee.amount || 0;
                        }
                        delete fee.registrations[registration_id];
                        promises.push(_fee.set(fee));
                    }
                }
                if (registration.event && deleteEvent) {
                    var _event = db.child('events/' + registration.event);
                    var event = yield _event.get();
                    if (event && event.registrations) {
                        delete event.registrations[registration_id];
                        promises.push(_event.set(event));
                    }
                }
            
                promises.push(_registration.remove());
            }
        }
        return yield promises;
    }).catch(onerror);
}

function processModification(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlist(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlistModification(verb, db, context, _registration, registration, fromAddress, templateBucket) {
};


function processRegistration(verb, db, context, registration_id, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket) {
    return co(function*() {
        if (config.verbose) { console.log("processRegistration"); }
        var _event = db.child('events/' + registration.event);
        var event = yield _event.get();
        if (event)
        {
            if (config.verbose) { console.log(event); }
            var confirmation = null;    
            var _confirmation = null;
            if (event.confirmation) {
                _confirmation = db.child('confirmations/' + event.confirmation);
                confirmation = yield _confirmation.get();
            }

            var _registeredUser = db.child('users/' + registration.registeredUser);
            var _registeringUser = db.child('users/' + registration.registeringUser);
            var _fee = db.child('fees/' + registration.fee);
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
                yield updateRegistration('Error-Register', db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
            }
        }
    }).catch(onerror);
};

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    console.error(err);
    errors.push(err);
}

function validateCancellation(db, user, registration, event, fee) {
    
    if (!event) {
        errors.push('Event was not valid');
        return false;
    }
    if (!registration) {
        errors.push('Registration was not valid');
        return false;
    }
    if (event.noRegistrationRequired) {
        return true;
    }
    
    if (!user) {
        registration.validationError = 'Registered user is invalid';
        errors.push(registration.validationError);
        return false;
    }
    
    if (registration.status === 'Billed') {
        registration.validationError = 'Registration has already been billed';
        errors.push(registration.validationError);
        return false;
    }
    
    if (registration.status === 'Cancelled') {
        errors.push('Registation already cancelled');
        return false;
    }
    
    if (event.cancelBy) {
        var threshold = moment(event.cancelBy);
        if (moment().isAfter(threshold)) {
            registration.validationError = 'Registration must be cancelled prior to ' + formatTime(event.cancelBy, 'MM/DD/YY @ h:mm A');
            errors.push(registration.validationError);
            return false;
        }
    }

    return true;
};

function validateReservation(db, reservationUser, reservingUser, reservation, reservation_id, location, interest, userReservationsForInterest, locationReservations, interestRule, locationRules, session) {
    if (!location) {
        errors.push('Location was not valid');
        return false;
    }
    if (!interest) {
        errors.push('Interest was not valid');
        return false;
    }
    if (!reservation) {
        errors.push('Reservation was not valid');
        return false;
    }
    if (!session) {
        errors.push('Session was not valid');
        return false;
    }
    if (!reservationUser) {
        reservation.validationError = 'Reservation user is invalid';
        errors.push(reservation.validationError);
        return false;
    }
    if (!reservingUser) {
        reservation.validationError = 'Reserving user is invalid';
        errors.push(reservation.validationError);
        return false;
    }
    
    if (!locationReservations) {
        reservation.validationError = 'Location Reservations are invalid';
        errors.push(reservation.validationError);
        return false;
    }

    if (reservingUser.isAdmin || reservingUser.isDeptHead) { //no rule checks
        return true;
    }
    
    if (reservation.hasGuest) {
        if (!interestRule.guestAllowed) {
            reservation.validationError = 'Reservation has guest and a guest is not allowed';
            errors.push(reservation.validationError);
            return false;
        }
    }
    
    if (reservation.dateReserved && session.date) {
        var dateReserved = moment.utc(reservation.dateReserved).utcOffset(-8); //since aws is utc only we have to offset to get 'smart' local aware dates
        var reservationDate = moment.utc(session.date).utcOffset(-8);
        var reservationEndDate = moment(session.endDate);
        var now = moment();
        if (reservationEndDate.isBefore(now)) {
            reservation.validationError = 'This session has already occurred';
            errors.push(reservation.validationError);
            return false;
        }
        var startOfReservationDate = reservationDate.clone().local().startOf('day');
        var startOfDateReserved = dateReserved.clone().local().startOf('day');
        if (config.verbose) {
            console.log('Start of reservation date:' + formatTime(startOfReservationDate, 'MM/DD/YY @ h:mm A'));
            console.log('Start of date Reserved:' + formatTime(startOfDateReserved, 'MM/DD/YY @ h:mm A'));
            console.log('Reservation date:' + formatTime(reservationDate, 'MM/DD/YY @ h:mm A'));
            console.log('Date Reserved:' + formatTime(dateReserved, 'MM/DD/YY @ h:mm A'));
        }
        var reservationWindowOpens = config.reservationWindowOpens;
        var windowOpens = startOfReservationDate.clone().add(reservationWindowOpens || 0, 'minutes');
        var dateReservedWindowOpens = startOfDateReserved.clone().add(reservationWindowOpens || 0, 'minutes');
        var windowCloses = null;
        var playBegins = null;
        var playEnds = null;
        var reservationDay = reservationDate.day();
        if (reservationDay === 0) //sunday
        {
            playBegins = startOfReservationDate.clone().add(interestRule.sundayPlayBegins||0, 'minutes');
            playEnds = startOfReservationDate.clone().add(interestRule.sundayPlayEnds || 0, 'minutes');
            if (config.verbose) {
                console.log('Play Begins:' + formatTime(playBegins, 'MM/DD/YY @ h:mm A') + ')  Play Ends:' + formatTime(playEnds, 'MM/DD/YY @ h:mm A'));
            }
        }
        else if (reservationDay === 6) //saturday
        {
            playBegins = startOfReservationDate.clone().add(interestRule.saturdayPlayBegins || 0, 'minutes');
            playEnds = startOfReservationDate.clone().add(interestRule.saturdayPlayEnds || 0, 'minutes');
        }
        else { //weekday
            playBegins = startOfReservationDate.clone().add(interestRule.weekdayPlayBegins || 0, 'minutes');
            playEnds = startOfReservationDate.clone().add(interestRule.weekdayPlayEnds || 0, 'minutes');
        }
        
        var playRange = moment.range(playBegins.clone(), playEnds.clone());
        if (config.verbose) {
            console.log('Reservation (' + formatTime(reservationDate, 'MM/DD/YY @ h:mm A') + ') Court open (' + formatRange(playRange, 'MM/DD/YY @ h:mm A') + ') ');
        }
        if (!reservationDate.within(playRange)) {
            reservation.validationError = 'Reservation (' + formatTime(reservationDate, 'MM/DD/YY @ h:mm A') + ') falls outside of when the court is open (' + formatRange(playRange, 'MM/DD/YY @ h:mm A') + ')';
            errors.push(reservation.validationError);
            
            return false;
        }
        
        if (dateReserved.isAfter(dateReservedWindowOpens)) {
            windowCloses = startOfReservationDate.clone().endOf('day');
        }
        else {
            windowCloses = windowOpens.clone();
        }

        var reservationCreated = moment(reservation.dateReserved);
        var advancedWindow = (interestRule.advancedWindowLength || 0);
        var generalWindow = (interestRule.generalWindowLength || 0);
        var window = advancedWindow + generalWindow;
        var reservationRange = moment.range(windowOpens.clone().subtract(window, 'days'),windowCloses.clone());
        if (!dateReserved.within(reservationRange)) {
            reservation.validationError = 'Reservation ('+formatTime(dateReserved,'MM/DD/YY @ h:mm A')+') falls outside of the '+window+ ' days when the reservation window is open ('+formatRange(reservationRange,'MM/DD/YY @ h:mm A')+')';
            errors.push(reservation.validationError);
            return false;
        }
        
        var advancedReservationRange = moment.range(windowOpens.clone().subtract(window, 'days'), windowOpens.clone().subtract(generalWindow, 'days'));
        if (reservationDate.within(advancedReservationRange)) {
            reservation.isAdvRes = true;
        }

        //interestRule frequency and allowed are ignored by mac
        for (var k = 0; k < locationRules.length; k++) {
            var locationRule = locationRules[k];
            if (locationRule.impactExcludes) {
                if (locationRule.impactExcludes.indexOf(reservationUser.classification) > -1) {//doesnt impact this member classification
                    continue;
                }
            }
            if (locationRule.impactIncludes) { 
                if (locationRule.impactIncludes.indexOf(reservationUser.classification) === -1) {//doesnt impact this member classification
                    continue;
                }
            }

            if (locationRule.type === 'NumberOfAdvancedReservations') {
                var advancedRange = null;
                if (locationRule.frequency === 'PerWeek') {
                    advancedRange = moment.range(startOfReservationDate.clone().startOf('week'), startOfReservationDate.clone().endOf('week'));
                }
                else {
                    advancedRange = moment.range(startOfReservationDate.clone(), startOfReservationDate.clone().endOf('day'));
                }

                var advancedReservationCount = 0;
                for (var i = 0; i < userReservationsForInterest.length; i++) {
                    var urfi = userReservationsForInterest[i];
                    if (urfi.value.isAdvRes) {
                        var urfiDate = moment(urfi.session.date);
                        if (urfiDate.within(advancedRange)) {
                            advancedReservationCount++;
                        }
                    }
                }
                if (locationRule.memberOutcome === 'Restriction') {
                    if (advancedReservationCount > locationRule.allowed) {
                        reservation.validationError = 'Only '+locationRule.allowed+' advanced reservations are allowed ' + locationRule.frequency;
                        errors.push(reservation.validationError);
                        return false;
                    }
                }
            }
            else if (locationRule.type === 'NumberOfReservationsPerGuest') {
                var advancedRange = null;
                if (locationRule.frequency === 'PerWeek') {
                    advancedRange = moment.range(startOfReservationDate.clone().startOf('week'), startOfReservationDate.clone().endOf('week'));
                }
                else {
                    advancedRange = moment.range(startOfReservationDate.clone(), startOfReservationDate.clone().endOf('day'));
                }
                
                var reservationCount = 0;
                for (var i = 0; i < userReservationsForInterest.length; i++) {
                    var urfi = userReservationsForInterest[i];
                    if (urfi.value.hasGuest) {
                        var urfiDate = moment(urfi.session.date);
                        if (urfiDate.within(advancedRange)) {
                            reservationCount++;
                        }
                    }
                }
                if (locationRule.memberOutcome === 'Restriction') {
                    if (reservationCount > locationRule.guestAllowed) {
                        reservation.validationError = 'Only ' + locationRule.guestAllowed + ' guests are allowed '+locationRule.frequency;
                        errors.push(reservation.validationError);
                        return false;
                    }
                }
            }
            else if (locationRule.type === 'RequiresPartner') {
                /* currently ignored
                var advancedRange = null;
                if (locationRule.frequency === 'PerWeek') {
                    advancedRange = moment.range(startOfReservationDate.clone().startOf('week'), startOfReservationDate.clone().endOf('week'));
                }
                else {
                    advancedRange = moment.range(startOfReservationDate.clone(), startOfReservationDate.clone().endOf('day'));
                }
                
                var reservationCount = 0;
                for (var i = 0; i < userReservationsForInterest.length; i++) {
                    var urfi = userReservationsForInterest[i];
                    if (urfi.value.hasGuest) {
                        var urfiDate = moment(urfi.session.date);
                        if (urfiDate.within(advancedRange)) {
                            reservationCount++;
                        }
                    }
                }
                if (locationRule.memberOutcome === 'Restriction') {
                    if (reservationCount > locationRule.guestAllowed) {
                        reservation.validationError = 'Only ' + locationRule.guestAllowed + ' guests are allowed ' + locationRule.frequency;
                        errors.push(reservation.validationError);
                        return false;
                    }
                }*/
            }

        }
    }
    
    if (session.date && session.endDate) {
        var sessionRange = moment.range(moment(session.date), moment(session.endDate));
        for (var lr = 0; lr < locationReservations.length; lr++) {
            var locationReservation = locationReservations[lr];
            if (locationReservation.id === reservation_id) {
                continue;
            }

            if (locationReservation) {
                if (locationReservation.value.reservationUser == reservation.reservationUser) {
                    reservation.validationError = location.name + ' has already been reserved by member ' + locationReservation.value.memberNumber+' today';
                    errors.push(reservation.validationError);
                    return false;
                }
                if (locationReservation.value.status === 'Reserved' || locationReservation.value.status === 'Billed') {
                    var lrRange = moment.range(moment(locationReservation.session.date), moment(locationReservation.session.endDate));
                    if (lrRange.isSame(sessionRange)) {
                        reservation.validationError = location.name + ' has already been reserved by member ' + locationReservation.value.memberNumber;
                        errors.push(reservation.validationError);
                        return false;
                    }
                }
            }
        }
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
        var promises = [];
        if (verb === 'Cancel') {
            if (registration) {
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
                        registeredMember: registeredUser.memberNumber || '',
                        registeringMember: registeringUser.memberNumber || '',
                        event: event.number || '',
                        startDate: event.startDate || moment().valueOf(),
                        endDate: event.endDate || moment().valueOf(),
                        location: locationName || '',
                        interest: interestName || ''
                    };
                    promises.push(_cancelledRegistrations.push(cancelledRegistration));
                }
            }
        }
        else if (verb === 'Register' || verb === 'Waitlist') {
            promises.push(_event.set(event));
            promises.push(_registration.set(registration));
        }

        yield promises;
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
            else if (verb === 'CancelEvent') {
                templateName = "event_cancellation.html";
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
                            var _sl = db.child('locations/' + session.location);
                            var sl = yield _sl.get();
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