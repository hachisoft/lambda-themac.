
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
    var stage = params.stage || 'dev';
    var result = '';
    if (params && params.event) {
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
            co(function*() {

                var _billingUser = db.child('users/' + params.billingUser);
                var _event = db.child('events/' + params.event);
                var event = yield _event.get();
                if (event) {
                    var registration_ids = [];
                    var registrations = [];
                    Object.keys(event.registrations).forEach(function (key) {
                        registration_ids.push(key);
                    });
                    
                    for (var k = 0; k < registration_ids.length; k++) {
                        var _registration = db.child('registrations/' + registration_ids[k]);
                        var registration = yield _registration.get();
                        if (registration) {
                            registrations.push({
                                'id': registration_ids[k],
                                'ref': _registration,
                                'value': registration
                            });
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
                            registration.status = 'Billed';
                            registration.billingDate = billingDate;
                            var _registration = registrations[i].ref;
                            promises.push(_registration.set(registration));
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
                    context.fail({});
                }
                    
            }).catch(onerror);
        });
    }
    else {
        context.fail({});
    }
};

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    console.error(err);
}
