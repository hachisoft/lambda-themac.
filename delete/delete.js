var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment');

var config = require('./config.js');
var util = require('util');

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    console.error(err.stack);
}

exports.handler = function (params, context) {
    var stage = params.stage || 'dev';
    var result = '';
    if (event) {
        // Read options from the event.
        console.log("Reading options from event:\n", util.inspect(params, { depth: 5 }));
        
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
            var errors = [];
            co(function*() {
                if (params.type === "event") {

                }
                else if (params.type === "registration" || params.type === "reservation") {
                    yield deleteRegistrationReservation(errors, params, db);
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
        });
    }
    else {
        console.log('No event object');

    }
};

function deleteRegistrationReservations(errors, params, db)
{
    co(function*() {
        var registrationPromises = [];
        var reservationPromises = [];
        var _registrations = [];
        var _reservations = [];
        if (params.registrations) {
            for (var i = 0; i < params.registrations.length; i++) {
                _registrations.push(params.registrations[i]);
                var _registration = db.child('registrations/' + params.registrations[i]);
                if (_registration) {
                    registrationPromises.push(_registration.get());
                }
            }
        }
        if (params.reservations) {
            for (var j = 0; j < params.reservations.length; j++) {
                _reservations.push(params.reservations[j]);
                var _reservation = db.child('reservations/' + params.reservations[j]);
                if (_reservation) {
                    reservationPromises.push(_reservation.get());
                }
            }
        }
        
        
        var registrations = yield registrationPromises;
        var reservations = yield reservationPromises;
        for (var k = 0; k < registrations.length; k++) {
            var registration = registrations[k];
            var registration_id = _registrations[k];
            var _registration = db.child('registrations/' + registration_id);
            if (registration) {
                if (registration.registeringUser) {
                    var _registeringUser = db.child('users/' + registration.registeringUser);
                    var registeringUser = yield _registeringUser.get();
                    if (registeringUser && registeringUser.createdRegistrations) {
                        delete registeringUser.createdRegistrations[registration_id];
                        yield _registeringUser.set(registeringUser);
                    }
                }
                if (registration.registeredUser) {
                    var _registeredUser = db.child('users/' + registration.registeredUser);
                    var registeredUser = yield _registeredUser.get();
                    if (registeredUser && registeredUser.registrations) {
                        delete registeredUser.registrations[registration_id];
                        yield _registeredUser.set(registeredUser);
                    }
                }
                if (registration.fee) {
                    var _fee = db.child('fees/' + registration.fee);
                    var fee = yield _fee.get();
                    if (fee && fee.registrations) {
                        delete fee.registrations[registration_id];
                        yield _fee.set(fee);
                    }
                }
                if (registration.event) {
                    var _event = db.child('events/' + registration.event);
                    var event = yield _event.get();
                    if (event && event.registrations) {
                        delete event.registrations[registration_id];
                        
                        if (registration.status === 'Reserved' && event.available) {
                            event.available--;
                        }
                        
                        yield _event.set(event);
                    }
                }
                
                yield _registration.remove();
            }
        }
        for (var l = 0; l < reservations.length; l++) {
            var reservation = reservations[l];
            var reservation_id = _reservations[l];
            var _reservation = db.child('reservations/' + reservation_id);
            if (reservation) {
                if (reservation.location) {
                    var _location = db.child('locations/' + reservation.location);
                    var location = yield _location.get();
                    if (location) {
                        if (location.reservations) {
                            delete location.reservations[reservation_id];
                        }
                        if (location.sessions && reservation.session) {
                            delete location.sessions[reservation.session];
                        }
                        yield _location.set(location);
                    }
                }
                if (reservation.reservationUser) {
                    var _reservationUser = db.child('users/' + reservation.reservationUser);
                    var reservationUser = yield _reservationUser.get();
                    if (reservationUser && reservationUser.reservations) {
                        delete reservationUser.reservations[reservation_id];
                        yield _reservationUser.set(reservationUser);
                    }
                }
                
                if (reservation.interest) {
                    var _interest = db.child('interests/' + reservation.interest);
                    var interest = yield _interest.get();
                    if (interest && interest.reservations) {
                        delete interest.reservations[reservation_id];
                        yield _interest.set(interest);
                    }
                }
                
                if (reservation.reservingUser) {
                    var _reservingUser = db.child('users/' + reservation.reservingUser);
                    var reservingUser = yield _reservingUser.get();
                    if (reservingUser && reservingUser.createdReservations) {
                        delete reservingUser.createdReservations[reservation_id];
                        yield _reservingUser.set(reservingUser);
                    }
                }
                
                if (reservation.session) {
                    var _session = db.child('sessions/' + reservation.session);
                    yield _session.remove();
                }
                
                yield _reservation.remove();
            }
        }
    }).catch(function (err) {
        console.log(err);
    });
}

function archiveAndDeleteEvent(errors, params, db, _event, event, event_id, cancellingUser)
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
                yield deleteRegistrations(errors, params, db, registrations, _registrations, cancelledEvent, false, false);
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
                yield deleteSessions(errors, params, db, sessions, _sessions);
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


