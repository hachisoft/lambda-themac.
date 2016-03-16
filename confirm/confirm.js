var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment-timezone');
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
    region: 'us-west-2',
    rateLimit: 20
}));

if (config.verbose) {
    console.log('started confirm.js');
}

exports.handler = function (params, context) {
    var errors = [];
    var fromAddress = null;

    var stage = params.stage || 'dev';
    var result = '';
    if (params && (params.registrations || params.reservation || params.event)) {
        if (config.verbose) {
            console.log(params);
            //console.log(context);
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
                co(function*() {
                    if (params.verb === 'Validate') {
                        yield processReservationValidation(errors, db, params.reservation, params.session);
                    }
                    else {
                        var _reservation = db.child('reservations/' + params.reservation);
                        var reservation = yield _reservation.get();
                        if (reservation) {
                            if (params.verb === 'Reserve' && reservation.status === 'Pending') {
                                yield processReservation(errors, params.verb, db, context, _reservation, reservation, params.reservation, fromAddress, templateBucket);
                            }
                            else if (params.verb === 'Cancel') {
                                yield processReservationCancel(errors, params.verb, db, context, _reservation, reservation, params.reservation, fromAddress, templateBucket);
                            }
                        }
                    }
                    if (errors.length > 0) {
                        context.fail(JSON.stringify(errors));
                    }
                    else {
                        context.succeed({});
                    }
                }).catch(function (err) {
                    if (config.verbose) {
                        console.error(err.stack);
                    }
                });
            }
            else if (params.event) {
                var _event = db.child('events/' + params.event);
                var _cancellingUser = db.child('users/' + params.cancellingUser);
                co(function*() {
                    var event = yield _event.get();
                    var cancellingUser = yield _cancellingUser.get();
                    if (event && params.verb === 'CancelEvent') {
                        yield processEventCancel(errors, params.verb, db, context, _event, event, params.event, cancellingUser, params.cancellingUser, fromAddress, templateBucket);
                    }
                    if (errors.length > 0) {
                        context.fail(JSON.stringify(errors));
                    }
                    else {
                        context.succeed({});
                    }
                    
                }).catch(function (err) {
                    if (config.verbose) {
                        console.error(err.stack);
                    }
                });
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
                                    yield processRegistration(errors, params.verb, db, context, registration_id, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket);
                                }
                                else if (registration.status === "Wishlist") {
                                    noneMatched = false;
                                    yield processWishlist(errors, db, context, registration);
                                }
                            }
                            else if (params.verb === "Cancel" || params.verb === "CancelEvent") {
                                noneMatched = false;
                                yield processRegistrationCancellation(errors, params.verb, params.cancellingUser, db, context, registration_id, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (params.verb === "Modify" && registration.status === "Reserved") {
                                noneMatched = false;
                                yield processModification(errors, params.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (params.verb === "Waitlist" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                yield processWaitlist(errors,params.verb,db, context, _registration, registration, fromAddress, templateBucket);
                            }
                            else if (params.verb === "WaitlistModify" && registration.status === "Pending" && registration.isOnWaitlist) {
                                noneMatched = false;
                                yield processWaitlistModify(errors, params.verb,db, context, _registration, registration, fromAddress, templateBucket);
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
                }).catch(function (err) {
                    if (config.verbose) {
                        console.error(err.stack);
                    }
                });
            }
        });
    }
    else {
        if (config.verbose) {
            console.log('No event object');
        }
        context.fail('No params object');
    }
};

function formatTime(epoch, fmt)
{
    return toLocalTime(epoch).format(fmt);
}

function toLocalTime(epoch)
{
    return moment(epoch).tz('America/Los_Angeles');
}

function formatRange(range, fmt)
{
    var from = formatTime(range.start, fmt);
    var to = formatTime(range.end, fmt);
    return from + ' - ' + to;
}

function processWishlist(errors,db, context, registration)
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
    }).catch(function (err) {
        console.log(err);  
    });
}

//note reservation and session are passed in an may be "temp" objects that aren't in firebase
function getReservationDetails(db, reservation, session, reservation_id, params)
{
    return co(function*() {
        
        params._reservationUser = db.child('users/' + reservation.reservationUser);
        params._reservingUser = db.child('users/' + reservation.reservingUser);
        params._location = db.child('locations/' + reservation.location);
        params._interest = db.child('interests/' + reservation.interest);
        
        params.location = yield params._location.get();
        params.interest = yield params._interest.get();
        params.reservationUser = yield params._reservationUser.get();
        params.reservingUser = yield params._reservingUser.get();

        var _reservationRule = db.child('reservationRules/' + params.interest.reservationRule);
        params.reservationRule = yield _reservationRule.get();
                
        
        //if passed null we don't care to collect rules
        if (params.rules) {
            var _rules = db.child("rules/");
            var _r = yield _rules.get();
            if (_r) {
                Object.keys(_r).forEach(function (key) {
                    var rule = _r[key];
                    var ruleLocations = Object.keys(rule.locations);
                    for (var k = 0; k < ruleLocations.length; k++) {
                        if (ruleLocations[k] === reservation.location) {
                            params.rules.push(rule);
                        }
                    }
                });
            }
        }
        
        //if passed null we don't care to collect user reservations for this interest
        if (params.userReservationsForInterest) {
            var _userReservationsForInterest = db.child("reservations/").orderByChild('reservationUser').equalTo(reservation.reservationUser);
            var _urfi = yield _userReservationsForInterest.get();
            if (_urfi) {
                var urfiKeys = Object.keys(_urfi);
                for (var w = 0; w < urfiKeys.length; w++) {
                    var key = urfiKeys[w];

                    if (reservation_id && key === reservation_id) {
                        continue;
                    }
                    if (_urfi[key].interest === reservation.interest) {
                        var urfi = _urfi [key];
                        var _urfiSession = db.child('sessions/' + urfi.session);
                        var urfiSession = yield _urfiSession.get();
                        if (urfiSession) {
                            params.userReservationsForInterest.push({
                                'id': key,
                                'value': urfi,
                                'session': urfiSession
                            });
                        }
                    }
                }
            }
        }

        //if passed null we don't care to collect reservations for this location
        if (params.locationReservations) {
            var _locationReservations = db.child("reservations/").orderByChild('location').equalTo(reservation.location);
            var _lr = yield _locationReservations.get();
            if (_lr) {
                var lrKeys = Object.keys(_lr);
                for (var t = 0; t < lrKeys.length; t++) {
                    var key = lrKeys[t];
                    var lr = _lr[key];
                    var _lrSession = db.child('sessions/' + lr.session);
                    var lrSession = yield _lrSession.get();
                    if (lrSession) {
                        params.locationReservations.push({
                            'id': key,
                            'value': lr,
                            'session': lrSession
                        });
                    }
                }
            }
        }
    }).catch(function (err) {
        console.log(err);
    });
}

function processReservationValidation(errors, db, reservation, session)
{
    return co(function*() {
        var params = {
            userReservationsForInterest: [],
            locationReservations: [],
            rules: []
        }
        
        //gather data from firebase for validation
        yield getReservationDetails(db, reservation, session, null, params);

        validateReservation(false, errors, db, params.reservationUser, params.reservingUser, reservation, null, params.location, params.interest, params.userReservationsForInterest, params.locationReservations, params.reservationRule, params.rules, session);

    }).catch(function (err) {
        console.log(err);
    });
}

function processReservation(errors,verb, db, context, _reservation, reservation, reservation_id, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    if (config.verbose) { console.log("processReservation"); }
    return co(function*() {
        var _session = db.child('sessions/' + reservation.session);
        var session = yield _session.get();
        
        var params = {
            userReservationsForInterest: [],
            locationReservations: [],
            rules: []
        }
        
        //gather data from firebase for validation
        yield getReservationDetails(db, reservation, session, reservation_id, params);
        
        var reservationUser = params.reservationUser;
        var _reservationUser = params._reservationUser;
        var reservingUser = params.reservingUser;
        var _reservingUser = params._reservingUser;
        var _location = params._location;
        var location = params.location;
        var interest = params.interest;
        var _interest = params._interest;
        var locationReservations = params.locationReservations;
        var reservationRule = params.reservationRule;
        var rules = params.rules;
        var userReservationsForInterest = params.userReservationsForInterest;
        
        if (session && reservationUser) {
            if (validateReservation(true, errors, db, reservationUser, reservingUser, reservation, reservation_id, location, interest, userReservationsForInterest, locationReservations, reservationRule, rules, session)) {
                reservation.status = "Reserved";
                
                var primaryMemberConfirmation = reservation.reservingUser === reservation.reservationUser;
                yield updateReservation(errors,verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
                var details = yield buildConfirmation(errors, verb, db, reservationUser, reservation.reservationUser, null, null, null, reservation, reservation_id, null, location.name, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket, fromAddress);
                //send each person on the confirmation their conf
                if (details) {
                    yield sendConfirmation(errors, db, reservationUser, reservation.reservationUser, details, fromAddress);
                }
                
                if (!primaryMemberConfirmation) { //now send one to the reserving user also
                    details = yield buildConfirmation(errors, verb, db, reservingUser, reservation.reservingUser, null, null, null, reservation, reservation_id, null, location.name, totalCost, adultCount, juniorCount, true, templateBucket,fromAddress);
                    //send each person on the confirmation their conf
                    if (details) {
                        yield sendConfirmation(errors, db, reservingUser, reservation.reservingUser, details, fromAddress);
                    }
                }
            }
            else {
                reservation.status = 'Error';
                reservation.isAdvRes = false;
                yield updateReservation(errors, 'Error-Reserve', db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
            }
        }
    }).catch(function (err) {
        console.log(err);  
    });
};

function processReservationCancel(errors, verb, db, context, _reservation, reservation, reservation_id, fromAddress, templateBucket) {
    var totalCost = null;
    var adultCount = null;
    var juniorCount = null;
    if (config.verbose) {
        console.log("processReservationCancel");
        console.log(reservation);
    }
    return co(function*() {
        var _session = db.child('sessions/' + reservation.session);
        var session = yield _session.get();
        
        var params = {
            userReservationsForInterest: null,
            locationReservations: null,
            rules: null
        }
        
        //gather data from firebase for validation
        yield getReservationDetails(db, reservation, session, null, params);
        
        var reservationUser = params.reservationUser;
        var _reservationUser = params._reservationUser;
        var reservingUser = params.reservingUser;
        var _reservingUser = params._reservingUser;
        var _location = params._location;
        var location = params.location;
        var interest = params.interest;
        var _interest = params._interest;
        var locationReservations = params.locationReservations;
        var reservationRule = params.reservationRule;
        var rules = params.rules;
        var userReservationsForInterest = params.userReservationsForInterest;

        if (session && reservationUser) {
            if (validateReservationCancel(errors,session,reservation_id,location, interest,reservingUser, reservationUser, reservation)) {
                reservation.status = "Cancelled";
                
                var primaryMemberConfirmation = reservation.reservingUser === reservation.reservationUser;
                var details = yield buildConfirmation(errors, verb, db, reservationUser, reservation.reservationUser, null, null, null, reservation, reservation_id, null, location.name, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket,fromAddress);
                
                yield updateReservation(errors, verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
                
                //send each person on the confirmation their conf
                if (details) {
                    yield sendConfirmation(errors, db, reservationUser, reservation.reservationUser, details, fromAddress);
                }
                
                if (!primaryMemberConfirmation) { //now send one to the reserving user also
                    details = yield buildConfirmation(errors, verb, db, reservingUser, reservation.reservingUser, null, null, null, reservation, reservation_id, null, location.name, totalCost, adultCount, juniorCount, true, templateBucket,fromAddress);
                    //send each person on the confirmation their conf
                    if (details) {
                        yield sendConfirmation(errors, db, reservingUser, reservation.reservingUser, details, fromAddress);
                    }
                }
            }
            else {
                yield updateReservation(errors, 'Error-Cancel', db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest);
            }
        }
    }).catch(function (err) {
        console.log(err);  
    });
};

function validateReservationCancel(errors, session, reservation_id, location, interest, reservingUser, reservationUser, reservation)
{
    return true;
}

function updateReservation(errors, verb, db, _reservation, reservation, reservation_id, _session, session, _location, location, _reservationUser, reservationUser, _reservingUser, reservingUser, _interest, interest) {
    return co(function*() {
        var promises = [];
        var _auditReservations = db.child('auditReservations')    
        var auditEntry = {
            'verb': verb,
            'timestamp': moment().valueOf(),
            'validationError': reservation.validationError || '',
            'reservation': reservation_id
        };
        if (config.verbose) {
            console.log("updateReservation verb:" + verb);
        }
        if (verb === 'Cancel') {
            if (reservation.asset) {
                var _asset = db.child('reservationAssets/' + reservation.asset);
                if (_asset) {
                    var asset = yield _asset.get();
                    if (asset) {
                        delete asset.reservations[reservation_id];
                        promises.push(_asset.set(asset));
                    }
                }
            }
            
            var sameUser = false;
            if (reservation.reservingUser === reservation.reservationUser) {
                sameUser = true;
            }
            
            if (sameUser) {
                var user = reservingUser || reservationUser;
                var _user = _reservingUser || _reservationUser;
                
                if (config.verbose) {
                    console.log("sameUser");
                    console.log(user);
                }

                if (user.reservations) {
                    if (user.memberNumber) {
                        auditEntry.reservedMember = user.memberNumber
                    }
                    
                    delete user.reservations[reservation_id];
                }
                
                if (user.createdReservations) {
                    if (user.memberNumber) {
                        auditEntry.reservingMember = user.memberNumber
                    }
                    
                    delete user.createdReservations[reservation_id];
                    
                }
                promises.push(_user.set(user));
            }
            else {
                if (reservationUser && reservationUser.reservations) {
                    if (reservationUser.memberNumber) {
                        auditEntry.reservedMember = reservationUser.memberNumber
                    }
                    
                    delete reservationUser.reservations[reservation_id];
                    if (!sameUser) { //note separateUser is used to distinguish so we don't end up with an add remove
                        promises.push(_reservationUser.set(reservationUser));
                    }

                }
                
                if (reservingUser && reservingUser.createdReservations) {
                    if (reservingUser.memberNumber) {
                        auditEntry.reservingMember = reservingUser.memberNumber
                    }
                    
                    delete reservingUser.createdReservations[reservation_id];
                    
                    promises.push(_reservingUser.set(reservingUser));

                }
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
                    console.log('Remove Session');
                }
                promises.push(_session.remove());
            }
                
            if (_reservation) {
                if (config.verbose) {
                    console.log('Remove Reservation');
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
        promises.push(_auditReservations.push(auditEntry));
        yield promises;
    }).catch(function (err) {
        console.log(err);
        console.log(err.stack);
    });
};

function processRegistrationCancellation(errors, verb, cancellingUser_id, db, context, registration_id, _registration, registration, fromAddress, templateBucket) {
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
            var _registeredUser = null;
            var registeredUser = null;
            if (registration.registeredUser) {
                _registeredUser = db.child('users/' + registration.registeredUser);
                registeredUser = yield _registeredUser.get();
            }
            var _registeringUser = db.child('users/' + registration.registeringUser);
            var _fee = db.child('fees/' + registration.fee);
            
            var _cancellingUser = null;
            var cancellingUser = null;
            if (cancellingUser_id) {
                _cancellingUser = db.child('users/' + cancellingUser_id);
                cancellingUser = yield _cancellingUser.get();
            }
            
            var confirmation = null;
            if (_confirmation)
                confirmation = yield _confirmation.get();
            
            var registeringUser = yield _registeringUser.get();
            var fee = yield _fee.get();
            if (validateCancellation(errors, db, cancellingUser, registration, event, fee)) {
                var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                yield updateRegistration(errors, verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
                if (event) {
                    if (event.sendMemberNotifications) {
                        if (registeredUser) {
                            var details = yield buildConfirmation(errors, verb, db, registeredUser, registration.registeredUser, event, registration.event, registration, null, null, confirmation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket, fromAddress);
                            //send each person on the confirmation their conf
                            if (details) {
                                yield sendConfirmation(errors, db, registeredUser, registration.registeredUser, details, fromAddress);
                            }
                        }
                        
                        if (!primaryMemberConfirmation) { //now send one to the registering user also
                            details = yield buildConfirmation(errors, verb, db, registeringUser, registration.registeringUser, event, registration.event, registration, null, null, confirmation, null, totalCost, adultCount, juniorCount, true, templateBucket, fromAddress);
                            //send each person on the confirmation their conf
                            if (details) {
                                yield sendConfirmation(errors, db, registeringUser, registration.registeringUser, details, fromAddress);
                            }
                        }
                    }
                    if (event.sendStaffNotifications) {
                        if (isAdmin(cancellingUser) && registeredUser && cancellingUser_id !== registration.registeringUser) {
                            var details = yield buildConfirmation(errors, verb, db, registeredUser, registration.registeredUser, event, registration.event, registration, null, null, confirmation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket, fromAddress);
                            //send each person on the confirmation their conf
                            if (details) {
                                yield sendConfirmation(errors, db, cancellingUser, cancellingUser_id, details, fromAddress);
                            }
                        }
                    }
                }
            }
            else {
                yield updateRegistration(errors, 'Error-Cancel', db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
            }
        }
    }).catch(function (err) {
        console.log(err);
        if (err.stack) {
            console.log(err.stack);  
        }
    });
};

function processEventCancel(errors, verb, db, context, _event, event, event_id, cancellingUser, cancellingUser_id, fromAddress, templateBucket) {
    if (config.verbose) {
        console.log("processEventCancellation");
    }
    return co(function*() {
        if (cancellingUser && event) {
            if (validateEventCancellation(errors, db, cancellingUser, event)) {
                var eventName = event.title || '';
                var eventNumber = event.number || '';
                var message = eventNumber + '\n';
                message += eventName + ' has been cancelled.\n';
                if (cancellingUser.email && event.sendStaffNotifications) {
                    yield sendEmail(fromAddress, cancellingUser.email, eventName + ' is cancelled', null, message, null);
                }
                yield archiveAndDeleteEvent(errors, db, _event, event, event_id, cancellingUser);
            }
        }
    }).catch(function (err) {
        console.log(err);  
    });
};

function validateEventCancellation(errors, db, cancellingUser, event)
{
    if (cancellingUser) {
        if (isAdmin(cancellingUser)) {
            return true;
        }
    }
    return false;
}

function archiveAndDeleteEvent(errors, db, _event, event, event_id, cancellingUser)
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
            'sendMemberNotifications': event.sendMemberNotifications || false,
            'sendStaffNotifications': event.sendStaffNotifications || false,
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
                yield deleteRegistrations(errors, db, registrations, _registrations, cancelledEvent, false, false);
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
                yield deleteSessions(errors, db, sessions, _sessions);
            }
        }

        if (event.confirmation) {
            var _confirmation = db.child('confirmations/' + event.confirmation);
            promises.push(_confirmation.remove());
        }

        promises.push(_cancelledEvent.set(cancelledEvent));
        promises.push(_event.remove());
        return yield promises;
    }).catch(function (err) {
        console.log(err);  
    });
}

function deleteSessions(errors,db, sessions, _sessions) {
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
    }).catch(function (err) {
        console.log(err);  
    });
}

function deleteRegistrations(errors, db, registrations, _registrations, cancelledEvent, deleteFee, deleteEvent)
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
    }).catch(function (err) {
        console.log(err);  
    });
}

function processModification(errors, verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlist(errors, verb, db, context, _registration, registration, fromAddress, templateBucket) {
};

function processWaitlistModification(errors, verb, db, context, _registration, registration, fromAddress, templateBucket) {
};


function processRegistration(errors, verb, db, context, registration_id, _registration, registration, totalCost, adultCount, juniorCount, fromAddress, templateBucket) {
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

            var _registeredUser = null;
            var registeredUser = null;
            if (registration.registeredUser) {
                _registeredUser = db.child('users/' + registration.registeredUser);
                registeredUser=yield _registeredUser.get();
            }
            var _registeringUser = db.child('users/' + registration.registeringUser);
            var _fee = db.child('fees/' + registration.fee);
            
            var registeringUser = yield _registeringUser.get();
            var fee = yield _fee.get();
            if (validateRegistration(errors, db, registeredUser, registeringUser, registration, event)) {
                registration.status = "Reserved";
                registration.dateRegistered = moment().valueOf();
                if (!event.noRegistrationRequired) {
                    if (event.available > 0) {
                        var _eventAvailable = db.child('events/' + registration.event + '/available');
                        yield _eventAvailable.transaction(function (available) {
                            if (available === null) {
                                return event.capacity;
                            }
                            else {
                                return available - 1;
                            }
                        });
                    }
                    else {
                        registration.status = "Pending";
                        registration.isOnWaitlist = true;
                        verb = "Waitlist"; //change the verb so the correct template is sent out
                        if (event.creatingUser) {
                            yield sendEventFull(errors, db, event, fromAddress);
                        }
                    }
                }
                var primaryMemberConfirmation = registration.registeringUser === registration.registeredUser;
                yield updateRegistration(errors, verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
                if (registeredUser && event.sendMemberNotifications) {
                    var details = yield buildConfirmation(errors, verb, db, registeredUser, registration.registeredUser, event, registration.event, registration, null, null, confirmation, null, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket, fromAddress);
                    //send each person on the confirmation their conf
                    if (details) {
                        yield sendConfirmation(errors, db, registeredUser, registration.registeredUser, details, fromAddress);
                    }
                }
                        
                if (!primaryMemberConfirmation) { //now send one to the registering user also
                    if ((isAdmin(registeringUser) && event.sendStaffNotifications) || event.sendMemberNotifications){
                        details = yield buildConfirmation(errors, verb, db, registeringUser, registration.registeringUser, event, registration.event, registration, null, null, confirmation, null, totalCost, adultCount, juniorCount, true, templateBucket, fromAddress);
                        //send each person on the confirmation their conf
                        if (details) {
                            yield sendConfirmation(errors, db, registeringUser, registration.registeringUser, details, fromAddress);
                        }
                    }
                }
            }
            else {
                registration.status = 'Error';
                yield updateRegistration(errors, 'Error-Register', db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee);
            }
        }
    }).catch(function (err) {
        console.log('processRegistration ' + err);
        console.log(err);  
    });
};


function validateCancellation(errors, db, cancellingUser, registration, event, fee) {
    
    if (!event) {
        AddError(errors,'Event was not valid');
        return false;
    }
    if (!registration) {
        AddError(errors, 'Registration was not valid');
        return false;
    }
    
    if (!cancellingUser) {
        AddError(errors, 'Cancelling User was not valid');
        return false;
    }
    
    if (isAdmin(cancellingUser))
        return true;

    if (event.noRegistrationRequired) {
        return true;
    }
    
    if (registration.status === 'Billed') {
        registration.validationError = 'Registration has already been billed';
        AddError(errors,registration.validationError);
        return false;
    }
    
    if (registration.status === 'Cancelled') {
        AddError(errors,'Registation already cancelled');
        return false;
    }
    
    if (event.cancelBy) {
        var threshold = moment(event.cancelBy);
        if (moment().isAfter(threshold)) {
            registration.validationError = 'Registration must be cancelled prior to ' + formatTime(event.cancelBy, 'MM/DD/YY @ h:mm A');
            AddError(errors,registration.validationError);
            return false;
        }
    }

    return true;
};

function validateReservation(dontEnforce, errors, db, reservationUser, reservingUser, reservation, reservation_id, location, interest, userReservationsForInterest, locationReservations, interestRule, locationRules, session) {
    var ret = true;
    if (!location) {
        AddError(errors, 'Location was not valid');
        return false;
    }
    if (!interest) {
        AddError(errors, 'Interest was not valid');
        return false;
    }
    if (!reservation) {
        AddError(errors, 'Reservation was not valid');
        return false;
    }
    if (!session) {
        AddError(errors, 'Session was not valid');
        return false;
    }
    if (!reservationUser) {
        reservation.validationError = 'Reservation user is invalid';
        AddError(errors,reservation.validationError);
        return false;
    }
    if (!reservingUser) {
        reservation.validationError = 'Reserving user is invalid';
        AddError(errors,reservation.validationError);
        return false;
    }
    
    if (!locationReservations) {
        reservation.validationError = 'Location Reservations are invalid';
        AddError(errors,reservation.validationError);
        return false;
    }

    if (dontEnforce && isAdmin(reservingUser)) { //no rule checks
        return true;
    }
    
    if (reservation.hasGuest) {
        if (!interestRule.guestAllowed) {
            reservation.validationError = 'Reservation has guest and a guest is not allowed';
            AddError(errors,reservation.validationError);
            ret = false;
        }
    }
    
    if (reservation.dateReserved && session.date) {
        var localDateReserved = toLocalTime(reservation.dateReserved); //since aws is utc only we have to offset to get 'smart' local aware dates
        var dateReserved = moment(reservation.dateReserved);
        var localReservationDate = toLocalTime(session.date);
        var reservationDate = moment(session.date);
        var reservationEndDate = moment(session.endDate);
        var now = moment();
        if (reservationEndDate.isBefore(now)) {
            reservation.validationError = 'The '+  formatTime(reservationDate, 'MM/DD/YY @ h:mm A')+'-'+ formatTime(reservationEndDate, 'MM/DD/YY @ h:mm A')+' session has already occurred';
            AddError(errors,reservation.validationError);
            ret = false;
        }
        var startOfReservationDate = localReservationDate.clone().startOf('day');
        var startOfDateReserved = localDateReserved.clone().startOf('day');
        var reservationWindowOpens = interestRule.timeRegistrationOpens;
        var windowOpens = startOfReservationDate.clone().add(reservationWindowOpens || 0, 'minutes');
        var dateReservedWindowOpens = startOfDateReserved.clone().add(reservationWindowOpens || 0, 'minutes');
        
        var windowCloses = startOfReservationDate.clone().endOf('day');
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
        if (!playRange.contains(reservationDate)) {
            reservation.validationError = 'Reservation (' + formatTime(reservationDate, 'MM/DD/YY @ h:mm A') + ') falls outside of when the court is open (' + formatRange(playRange, 'MM/DD/YY @ h:mm A') + ')';
            AddError(errors,reservation.validationError);
            ret = false;
        }
        
        var advancedWindow = (interestRule.advancedWindowLength || 0);
        var generalWindow = (interestRule.generalWindowLength || 0);
        var window = generalWindow;
        if (dateReserved.isAfter(dateReservedWindowOpens)) { //the advanced window is now open
            window += advancedWindow;
        }
        
        var reservationCreated = moment(reservation.dateReserved);
        
        
        var reservationRange = moment.range(windowOpens.clone().subtract(window-1, 'days'), windowCloses.clone());
        
        if (config.verbose) {
            console.log('Start of reservation date:' + formatTime(startOfReservationDate, 'MM/DD/YY @ h:mm A'));
            console.log('Start of date Reserved:' + formatTime(startOfDateReserved, 'MM/DD/YY @ h:mm A'));
            console.log('Reservation date:' + formatTime(reservationDate, 'MM/DD/YY @ h:mm A'));
            console.log('Date Reserved:' + formatTime(dateReserved, 'MM/DD/YY @ h:mm A'));
            console.log('Window Opens:' + formatTime(windowOpens, 'MM/DD/YY @ h:mm A'));
            console.log('Window Closes:' + formatTime(windowCloses, 'MM/DD/YY @ h:mm A'));
            console.log('Reservation Range:' + formatRange(reservationRange, 'MM/DD/YY @ h:mm A'));
        }
        
        if (!reservationRange.contains(dateReserved)) {
            reservation.validationError = 'Reservation must be made when the reservation window is open ('+formatRange(reservationRange,'MM/DD/YY @ h:mm A')+')';
            AddError(errors,reservation.validationError);
            ret = false;
        }
        
        var advancedReservationRange = moment.range(windowOpens.clone().subtract(window-1, 'days'), windowOpens.clone().subtract(generalWindow-1, 'days'));
        if (advancedReservationRange.contains(reservationDate)) {
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
                        if (advancedRange.contains(urfiDate)) {
                            advancedReservationCount++;
                        }
                    }
                }
                if (locationRule.memberOutcome === 'Restriction') {
                    if (advancedReservationCount > locationRule.allowed) {
                        reservation.validationError = 'Only '+locationRule.allowed+' advanced reservations are allowed ' + locationRule.frequency;
                        AddError(errors,reservation.validationError);
                        ret = false;
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
                        if (advancedRange.contains(urfiDate)) {
                            reservationCount++;
                        }
                    }
                }
                if (locationRule.memberOutcome === 'Restriction') {
                    if (reservationCount > locationRule.guestAllowed) {
                        reservation.validationError = 'Only ' + locationRule.guestAllowed + ' guests are allowed '+locationRule.frequency;
                        AddError(errors,reservation.validationError);
                        ret = false;
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
                        if (advancedRange.contains(urfiDate)) {
                            reservationCount++;
                        }
                    }
                }
                if (locationRule.memberOutcome === 'Restriction') {
                    if (reservationCount > locationRule.guestAllowed) {
                        reservation.validationError = 'Only ' + locationRule.guestAllowed + ' guests are allowed ' + locationRule.frequency;
                        AddError(errors,reservation.validationError);
                        return false;
                    }
                }*/
            }

        }
    }
    
    if (session.date && session.endDate) {
        var sessionDate = moment(session.date);
        var sessionEndDate = moment(session.endDate);
        var sessionRange = moment.range(sessionDate, sessionEndDate);
        for (var lr = 0; lr < locationReservations.length; lr++) {
            var locationReservation = locationReservations[lr];
            if (locationReservation) {
                var lrSessionDate = moment(locationReservation.session.date);
                var lrSessionEndDate = moment(locationReservation.session.endDate);
                var lrRange = moment.range(lrSessionDate, lrSessionEndDate);
                if (locationReservation.id === reservation_id) {
                    continue;
                }

                if (locationReservation.value.status === 'Reserved' || locationReservation.value.status === 'Billed') {
                    if (locationReservation.value.reservationUser === reservation.reservationUser) {
                        if (lrSessionDate.isSame(sessionDate, 'day')) {
                            reservation.validationError = location.name + ' has already been reserved by member ' + locationReservation.value.memberNumber + ' today';
                            AddError(errors,reservation.validationError);
                            ret = false;
                        }
                    }
                    if (lrRange.overlaps(sessionRange)) {
                        reservation.validationError = location.name + ' has already been reserved by member ' + locationReservation.value.memberNumber;
                        AddError(errors,reservation.validationError);
                        ret = false;
                    }
                }
            }
        }

        for (var v = 0; v < userReservationsForInterest.length; v++) {
            var urfi = userReservationsForInterest[v];
            if (urfi) {
                var urfiDate = moment(urfi.session.date);
                if (urfiDate) {
                    if (urfiDate.isSame(sessionDate, 'day')) {
                        reservation.validationError = 'Member '+urfi.value.memberNumber + ' has already made a '+interest.name+' reservation ('+ formatTime(urfiDate,'MM/DD/YY @ h:mm A')+')';
                        AddError(errors,reservation.validationError);
                        ret = false;
                    }
                }
            }
        }
    }
    return ret;
};

function isAdmin(user)
{
    if (user) {
        return user.isAdmin || user.isDeptHead;
    }
    return false;
}

function validateRegistration(errors, db, user, registeringUser, registration, event) {
    if (!event)
        return false;
    if (!registration)
        return false;
    
    if (event.status !== 'Approved' && event.status !== 'Billed' ) {
        registration.validationError = 'Event '+event.number+' has a status of' + event.status;
        AddError(errors,registration.validationError);
        return false;
    }

    if (event.noRegistrationRequired)
        return true;
    
    if (!user) {
        if (!registration.isGuest && !registration.isRapidRegistration) {
            registration.validationError = 'Registered user is invalid';
            AddError(errors,registration.validationError);
            return false;
        }
    }
    
    if (!registeringUser) {
        registration.validationError = 'Registering user is invalid';
        AddError(errors,registration.validationError);
        return false;
    }
    
    if (isAdmin(registeringUser)) { //no rule checks
        return true;
    }
    
    if (registration.status === 'Billed') {
        registration.validationError = 'This registration has already been billed';
        AddError(errors,registration.validationError);
        return false;
    }
    
    if (registration.status === 'Cancelled') {
        registration.validationError = 'This registration has already been cancelled';
        AddError(errors,registration.validationError);
        return false;
    }
    
    if (registration.status === 'Reserved') { //already reserved?
        return false;
    }
    var valid = validateEventRegistrationRules(errors, user, registeringUser, registration, event);
    if (event.restrictOnError)
        return valid;
    return true;
}

function validateEventRegistrationRules(errors, user, registeringUser, registration, event) {
    var dob = null;

    if (user) {
        dob = moment(user.dob);
        var isMale = false;
        if (user.gender === 'Male') {
            isMale = true;
        }
        if (!event.allowMales && isMale) {
            registration.validationError = 'Event does not allow males';
            AddError(errors,registration.validationError);
            return false;
        }
        if (!event.allowFemales && !isMale) {
            registration.validationError = 'Event does not allow females';
            AddError(errors,registration.validationError);
            return false;
        }
    }
    if (!event.allowGuests && registration.isGuest) {
        registration.validationError = 'Event does not allow guests';
        AddError(errors,registration.validationError);
        return false;
    }
    
    if (registration.guestAge) {
        dob=moment().subtract(registration.guestAge, 'years');
    }
    
    if (!registration.isRapidRegistration) {
        if (!dob) {
            registration.validationError = 'Dob is invalid';
            AddError(errors,registration.validationError);
            return false;
        }
        
        if (event.minAge) {
            var threshold = moment().subtract(event.minAge, 'years');
            if (dob.isAfter(threshold)) {
                registration.validationError = 'User is not old enough to register';
                AddError(errors,registration.validationError);
                return false;
            }
        }
        if (event.maxAge) {
            var threshold = moment().subtract(event.maxAge, 'years');
            if (dob.isBefore(threshold)) {
                registration.validationError = 'User is too old to register';
                AddError(errors,registration.validationError);
                return false;
            }
        }
    }

    if (!event.allowWaitlist) {
        if (event.available < 1) {
            registration.validationError = 'Event does not allow waitlisting, and no has no available capacity';
            AddError(errors,registration.validationError);
            return false;
        }
    }
    
    if (event.registrationOpen) {
        var threshold = moment(event.registrationOpen);
        if (moment().isBefore(threshold)) {
            registration.validationError = 'Event registration has not opened yet';
            AddError(errors,registration.validationError);
            return false;
        }
    }
    if (event.registrationClose) {
        var threshold = moment(event.registrationClose);
        if (moment().isAfter(threshold)) {
            registration.validationError = 'Event registration has already closed';
            AddError(errors,registration.validationError);
            return false;
        }
    }
    
    return true;
};

function AddError(errors, err)
{
    if (errors && err) {
        errors.push(err);
        console.log(err);
    }
}

function getFirebasePath(root, path)
{
    return path.replace(root, '');
}

function updateRegistration(errors, verb, db, registration_id, _registration, registration, _event, event, _registeredUser, registeredUser, _registeringUser, registeringUser, _fee, fee) {
    if (config.verbose) {
        console.log('updateRegistration:'+verb);
    }
    return co(function*() {
        var atomicWrite = {};
        var promises = [];
        var _auditRegistrations = db.child('auditRegistrations');
        var auditEntry = {
            'verb': verb,
            'timestamp': moment().valueOf(),
            'validationError': registration.validationError || '',
            'registration': registration_id
        };
        if (verb === 'Cancel' || verb === 'CancelEvent') {
            if (registration) {
                if (!event.noRegistrationRequired && registration.status === 'Reserved') {
                    var _eventAvailable = db.child('events/' + registration.event + '/available');
                    yield _eventAvailable.transaction(function (available) {
                        return available + 1;
                    });
                }
                
                registration.status = "Cancelled";

                var locationName = null;
                var interestName = null;
                //this will delete the registration from associated models and add a new item to cancelledRegistrations
                
                var sameUser = false;
                if (registration.registeredUser === registration.registeringUser) {
                    sameUser = true;
                }
                
                if (sameUser) {
                    var _user = _registeringUser || _registeredUser;
                    var user = registeringUser || registeredUser;
                    
                    if (config.verbose) {
                        console.log("sameUser");
                        console.log(user);
                    }
                    
                    if (registration.registeringUser) {
                        if (user && user.createdRegistrations) {
                            delete user.createdRegistrations[registration_id];
                        }
                    }
                    if (registration.registeredUser) {
                        if (user && user.registrations) {
                            delete user.registrations[registration_id];
                        }
                    }
                    atomicWrite[getFirebasePath(_user.root(),_user.toString())] = user;
                }
                else {
                    if (registration.registeringUser) {
                        if (registeringUser && registeringUser.createdRegistrations) {
                            delete registeringUser.createdRegistrations[registration_id];
                            atomicWrite[getFirebasePath(_registeringUser.root(),_registeringUser.toString())] = registeringUser;
                        }
                    }
                    if (registration.registeredUser) {
                        if (registeredUser && registeredUser.registrations) {
                            delete registeredUser.registrations[registration_id];
                            atomicWrite[getFirebasePath(_registeredUser.root(),_registeredUser.toString())] = registeredUser;
                        }
                    }
                }
                if (registration.fee) {
                    if (fee && fee.registrations) {
                        delete fee.registrations[registration_id];
                        atomicWrite[getFirebasePath(_fee.root(),_fee.toString())] = fee;
                    }
                }
                if (registration.event) {
                    if (event){
                        if (event.registrations) {
                            delete event.registrations[registration_id];
                            atomicWrite[getFirebasePath(_event.root(),_event.toString()+"/registrations")] = event.registrations;
                        }
                        if (event.interests) {
                            var interestKeys = Object.keys(event.interests);
                            for (var i = 0; i < interestKeys.length; i++) {
                                var key = interestKeys[i];
                                var _interest = db.child('interests/' + key);
                                var interest = yield _interest.get();
                                if (interest) {
                                    if (interestName) {
                                        interestName += interest.name || '';
                                    }
                                    else {
                                        interestName = interest.name || '';
                                    }
                                }
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

                if (registeringUser && event) {
                    if (config.verbose) {
                        console.log('added cancelledRegistrations');
                    }
                    var _cancelledRegistrations = db.child('cancelledRegistrations/');
                    var cancelledRegistration = {
                        registeredMember: registeredUser?registeredUser.memberNumber || '':'',
                        firstName: registration.firstName || '',
                        lastName: registration.lastName||'',
                        registeringMember: registeringUser.memberNumber || '',
                        event: event.number || '',
                        startDate: event.startDate || moment().valueOf(),
                        endDate: event.endDate || moment().valueOf(),
                        location: locationName || '',
                        interest: interestName || ''
                    };
                    if (registeredUser&&registeredUser.memberNumber) {
                        auditEntry.registeredMember = registeredUser.memberNumber;
                    }
                    
                    if (registration.firstName) {
                        auditEntry.firstName = registration.firstName;
                    }
                    
                    if (registration.lastName) {
                        auditEntry.lastName = registration.lastName;
                    }
                        
                    if (registeringUser.memberNumber) {
                        auditEntry.registeringMember = registeringUser.memberNumber;
                    }
                    if (event.number) {
                        auditEntry.eventNumber = event.number;
                    }
                    if (event.startDate) {
                        auditEntry.startDate = event.startDate;
                    }
                    if (event.endDate) {
                        auditEntry.endDate = event.endDate;
                    }
                    if (locationName) {
                        auditEntry.location = locationName;
                    }
                    if (interestName) {
                        auditEntry.interest = interestName;
                    }
                    promises.push(_cancelledRegistrations.push(cancelledRegistration));
                }
            }
        }
        else if (verb === 'Register' || verb === 'Waitlist' || verb === 'Error-Cancel' || verb === 'Error-Register') {
            
            if (registeredUser && registeredUser.memberNumber) {
                auditEntry.registeredMember = registeredUser.memberNumber;
            }
            if (registration.isGuest) {
                auditEntry.isGuest = registration.isGuest;
            }
            if (registeringUser && registeringUser.memberNumber) {
                auditEntry.registeringMember = registeringUser.memberNumber;
            }
            if (event.number) {
                auditEntry.eventNumber = event.number;
            }
            if (event.startDate) {
                auditEntry.startDate = event.startDate;
            }
            if (event.endDate) {
                auditEntry.endDate = event.endDate;
            }
            if (locationName) {
                auditEntry.location = locationName;
            }
            if (interestName) {
                auditEntry.interest = interestName;
            }

            promises.push(_registration.set(registration));
        }
        promises.push(_auditRegistrations.push(auditEntry));
        promises.push(db.update(atomicWrite));
        yield promises;
    }).catch(function (err) {
        console.log(err);  
    });
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

function sendConfirmation(errors, db, user, user_id, details, fromAddress) {
    return co(function*() {
        if (user && details && fromAddress) {
            if (config.verbose) { console.log("sendConfirmation from " + fromAddress + " to " + user.email); }
            
            if (user.sendNotificationConfirmation) {
                //update just this attribute
                var _user = db.child('users/' + user_id+'/numNewNotifications');
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
                    type: 'Confirmation',
                    timestamp: moment().valueOf(),
                    title: details.confirmationNotificationTitle,
                    description: details.confirmationNotificationDescription,
                    user: user_id
                };
                
                if (details.linkTo && details.identifier) {
                    notification.linkTo = details.linkTo;
                    notification.identifier = details.identifier;
                }

                yield _notification.set(notification);
            }
            
            if (user.sendEmailConfirmation) {
                yield sendEmail(fromAddress, details.email, details.subject, details.content,null,details.attachment);
            }
        }
    }).catch(function (err) {
        console.log(err);  
    });
};

function sendEventFull(errors, db, event, fromAddress){
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
    }).catch(function (err) {
        console.log(err);  
    });
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

function addLine(text, line)
{
    return text + (line + "<br>");
}

function buildConfirmation(errors, verb, db, user, user_id, event, event_id, registration, reservation, reservation_id, confirmation, location, totalCost, adultCount, juniorCount, primaryMemberConfirmation, templateBucket, fromAddress) {
    if (config.verbose) {
        console.log("buildConfirmation");
    }
    return co(function*() {
        var mark = require('markup-js');
        
        var template = null;
        var subject = "";
        var confirmationNotificationTitle = "";
        var confirmationNotificationDescription = "";
        if (confirmation) {
            if (confirmation.confirmationTemplate) {
                if (verb === 'Register') {
                    template = yield download(confirmation.confirmationTemplate);
                }
                else if (verb === 'Reserve') {
                    template = yield download(confirmation.confirmationTemplate);
                }
            }
            else if (confirmation.cancellationTemplate && verb === 'Cancel') {
                template = yield download(confirmation.cancellationTemplate);
            }
            else if (confirmation.modificationTemplate && verb === 'Modify') {
                template = yield download(confirmation.modificationTemplate);
                }
            else if (confirmation.waitlistTemplate && verb === 'Waitlist') {
                template = yield download(confirmation.waitlistTemplate);
            }
            else if (confirmation.waitlistModificationTemplate && verb === 'WaitlistModify') {
                template = yield download(confirmation.waitlistModificationTemplate);
            }
            
            if (confirmation.confirmationSubject) {
                subject = confirmation.confirmationSubject;
            }
        } else {
            var templateName = "confirmation.html";
            subject = "MAC Registration Confirmation";
            if (verb === 'Cancel') {
                subject = "MAC Registration Cancellation";
                templateName = "cancellation.html";
                if (reservation) {
                    subject = "MAC Reservation Cancellation";
                    templateName = "reservation_cancellation.html";
                }
            }
            else if (verb === 'CancelEvent') {
                subject = "MAC Event Cancellation";
                templateName = "event_cancellation.html";
            }
            else if (verb === 'Reserve') {
                subject = "MAC Reservation Confirmation";
                templateName = "reservation_confirmation.html";
            }
            else if (verb === 'Modify') {
                subject = "MAC Registration Modification";
                templateName = "modification.html";
                if (reservation) {
                    subject = "MAC Reservation Modification";
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
        if (verb === 'Register' || verb === 'Reserve') {
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
        var reservationAsset = null;
        var linkTo = null;
        var identifier = null;
        var sessions = [];
        if (verb === 'Register') {
            if (event_id) {
                linkTo = "event";
                identifier = event_id;
            }
            confirmationNotificationDescription=addLine(confirmationNotificationDescription, "<strong>Registered</strong><br>");
        }
        else if (verb === 'Reserve') {
            if (reservation_id) {
                linkTo = "edit.reservation";
                identifier = reservation_id;
            }
            confirmationNotificationDescription=addLine(confirmationNotificationDescription, "<strong>Reserved</strong><br>");
        }
        else if (verb === 'Cancel') {
            confirmationNotificationDescription=addLine(confirmationNotificationDescription, "<strong>Cancelled</strong><br>");
        }
        else if (verb === 'Waitlist') {
            if (event_id) {
                linkTo = "event";
                identifier = event_id;
            }
            confirmationNotificationDescription = addLine(confirmationNotificationDescription, "<strong>Waitlisted</strong><br>");
        }
        else if (verb === 'WaitlistModified') {
            if (event_id) {
                linkTo = "event";
                identifier = event_id;
            }
            confirmationNotificationDescription = addLine(confirmationNotificationDescription, "<strong>Waitlist Changed</strong><br>");
        }

        if (event) {
            cancelBy = formatTime(event.cancelBy,'MMM Do h:mm a');
            eventName = event.title;
            eventNumber = event.number;
            confirmationNotificationTitle = eventName + " - " + eventNumber;
            
            if (cal) {
                cal.setName(eventName);
            }

            eventDate = formatTime(event.startDate, 'MMM Do');
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
                            if (ce && user) {
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
        if (eventDate) {
            confirmationNotificationDescription = addLine(confirmationNotificationDescription, "<strong>Date:</strong> "+eventDate);
        }
           
        if (sessions && sessions.length) {
            confirmationNotificationDescription = addLine(confirmationNotificationDescription, "<strong>Sessions</strong>");
            for (var i = 0; i < sessions.length; i++) {
                var s = sessions[i];
                confirmationNotificationDescription = addLine(confirmationNotificationDescription, s.date + ": " + s.startTime + " - " + s.endTime);
            }
            confirmationNotificationDescription += "<br>";
        }

        if (eventDescription) {
            confirmationNotificationDescription = addLine(confirmationNotificationDescription, eventDescription);
        }

        var comments = '';
        if (registration) {
            comments = registration.comments;
        }
            
        if (reservation) {
            
            eventName = location + " Reservation";
            confirmationNotificationTitle = eventName;

            if (reservation.asset) {
                var _a = db.child('reservationAssets/' + reservation.asset);
                var asset = yield _a.get();
                if (asset) {
                    reservationAsset = asset.name;
                }
            }
            var _c = db.child('sessions/' + reservation.session);
            var session = yield _c.get();
            if (session) {
                
                if (cal) {
                    
                    cal.setName(eventName);
                    var ce = cal.createEvent({
                        start: moment(session.date).toDate(),
                        end: moment(session.date + (session.duration * 60000)).toDate(),
                        summary: eventName,
                        description: eventDescription,
                        location: location,
                        method: 'publish'
                    });
                    if (ce && user) {
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
                reservationDate = formatTime(session.date, 'dddd MMM. D');
                confirmationNotificationDescription = addLine(confirmationNotificationDescription, "<strong>Date:</strong> "+reservationDate);
                reservationStartTime = formatTime(session.date, 'h:mm a');
                confirmationNotificationDescription = addLine(confirmationNotificationDescription, "<strong>Time:</strong> " +reservationStartTime);
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
        
        if (reservationAsset) {
            confirmationNotificationDescription= addLine(confirmationNotificationDescription, reservationAsset);
        }
        
        var details = {
            memberName: user?user.fullName:'',
            user_id: user_id || '',
            email: user?user.email:'',
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
            attachment: attachment,
            subject: subject,
            confirmationNotificationTitle: confirmationNotificationTitle,
            confirmationNotificationDescription: confirmationNotificationDescription
        };
        
        if (linkTo) {
            details.linkTo = linkTo;
        }
        
        if (identifier) {
            details.identifier = identifier;
        }
        
        if (reservationAsset) {
            details.reservationAsset = reservationAsset;
        }
        
        if (template) {
            var templateBody = template.Body.toString();
            details.content = mark.up(templateBody, details);
        }
        
        if (config.verbose) {
            console.log(details);
        }
        
        return details;
        
    }).catch(function (err) {
        console.log(err);  
    });
};