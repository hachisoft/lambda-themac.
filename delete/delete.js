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

exports.handler = function (event, context) {
    var stage = event.stage || 'prod';
    var result = '';
    if (event) {
        // Read options from the event.
        console.log("Reading options from event:\n", util.inspect(event, { depth: 5 }));
        
        var fromAddress = null;
        var firebaseUrl = null;
        var authToken = null;
        var templateBucket = config.templateBucket;
        if (stage !== 'dev') {
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
            fromAddress = config.prodFromAddress;
        }
        else {
            config.templateBucket = 'dev.' + templateBucket;
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
            
            var registrationPromises = [];
            var reservationPromises = [];
            var _registrations = [];
            var _reservations = [];
            if (event.registrations) {
                for (var i = 0; i < event.registrations.length; i++) {
                    _registrations.push(event.registrations[i]);
                    var _registration = db.child('registrations/' + event.registrations[i]);
                    if (_registration) {
                        registrationPromises.push(_registration.get());
                    }
                }
            }
            if (event.reservations) {
                for (var j = 0; j < event.reservations.length; j++) {
                    _reservations.push(event.reservations[j]);
                    var _reservation = db.child('reservations/' + event.reservations[j]);
                    if (_reservation) {
                        reservationPromises.push(_reservation.get());
                    }
                }
            }

            co(function*() {
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
                context.succeed({});
            }).catch(onerror);
        });
    }
    else {
        console.log('No event object');

    }
};

