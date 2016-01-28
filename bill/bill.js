var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment');

var config = require('./config.js');

if (config.verbose) {
    console.log('started bill.js');
}

var fromAddress = null;
var serverTimeOffset = 0;
exports.handler = function (params, context) {
    if (config.verbose) {
        console.log(params);
        console.log(context);
    }

    var stage = params.stage || 'dev';
    var result = '';
    if (params && params.event && params.billingUser) {
        
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
            co(function*() {

                var _billingUser = db.child('users/' + params.billingUser);
                var _event = db.child('events/' + params.event);
                var event = yield _event.get();
                if (event) {
                    if (event.status === 'Approved' || event.status==='Billed') {
                        var registration_ids = [];
                        var registrations = [];
                        Object.keys(event.registrations).forEach(function (key) {
                            registration_ids.push(key);
                        });
                        
                        for (var k = 0; k < registration_ids.length; k++) {
                            var _registration = db.child('registrations/' + registration_ids[k]);
                            var registration = yield _registration.get();
                            if (registration) {
                                var _user = db.child('users/' + registration.registeringUser);
                                var user = yield _user.get();
                                if (user) {
                                    registrations.push({
                                        'id': registration_ids[k],
                                        'ref': _registration,
                                        'value': registration,
                                        'registeringUser': user
                                    });
                                }
                            }
                        }
                        
                        var billingUser = yield _billingUser.get();
                        var billingDate = moment().valueOf();
                        if (registrations && billingUser) {
                            var promises = [];
                            event.status = 'Billed';
                            event.billedDate = billingDate;
                            promises.push(_event.set(event));
                            for (var i = 0; i < registrations.length; i++) {
                                var registration = registrations[i].value;
                                var user = registrations[i].registeringUser;
                                if (user) {
                                    if (registration.status === 'Reserved' && user.status === 'Active') { //must be reserved to be billed & active
                                        registration.status = 'Billed';
                                        registration.billingDate = billingDate;
                                        var _registration = registrations[i].ref;
                                        promises.push(_registration.set(registration));
                                    }
                                    else if (registration.status === 'Billed') {
                                        //already billed
                                    }
                                    else {
                                        var _billingErrors = db.child('billingErrors/');
                                        if (registration.status !== 'Reserved') {
                                            var err = {
                                                billingMember: billingUser.memberNumber,
                                                billingDate: billingDate,
                                                event: event.number,
                                                message: "Registration status of" + registration.status + " is invalid for registrations/" + registration.id
                                            };
                                            promises.push(_billingErrors.push(err));
                                        }
                                        if (user.status !== 'Active') {
                                            var err = {
                                                billingMember: billingUser.memberNumber,
                                                billingDate: billingDate,
                                                event: event.number,
                                                message: "Member " + user.memberNumber + " is not 'Active' for registrations/" + registration.id
                                            };
                                            promises.push(_billingErrors.push(err));
                                        }
                                    }
                                }
                            }
                            
                            var _auditBilling = db.child('auditBillings/');
                            var audit = {
                                billingMember: billingUser.memberNumber,
                                billingDate: billingDate,
                                event: event.number
                            };
                            promises.push(_auditBilling.push(audit));
                            
                            yield promises;
                            
                            context.succeed({});
                        }
                        else {
                            context.fail({});
                        }
                    }
                    else {
                        context.fail("Unable to bill event " + event.number + " because it's status is " + event.status);
                    }
                }
                else {
                    context.fail("Invalid Event");
                }
                    
            }).catch(function (err) {
                console.log(err);
            });
        });
    }
    else {
        context.fail("Invalid parameters");
    }
};


