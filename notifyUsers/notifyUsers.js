var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var co = require('co');
var config = require('./config.js');
var util = require('util');
var Firebase = require('firebase');
var NodeFire = require('nodefire');

var SNS = new aws.SNS();

if (config.verbose) {
    console.log('started notifyUsers.js');
}

function onerror(err) {
    // log any uncaught errors
    // co will not throw any errors you do not handle!!!
    // HANDLE ALL YOUR ERRORS!!!
    if (config.verbose) {
        console.error(err.stack);
    }
}

exports.handler = function (params, context) {
    var result = '';
    if (params && params.Records && params.Records.length >= 1) {
        var record = params.Records[0];
        if (record && record.Sns && record.Sns.Message) {
            params = JSON.parse(record.Sns.Message);
            
            if (config.verbose) {
                console.log("Reading nested entries from params:\n", util.inspect(params, { depth: 5 }));
            }

            var stage = params.stage || 'dev';
            var bulkARN = null;
            if (stage === 'v0') {
                bulkARN = config.prodBulkARN;
                authToken = config.prodSecret;
                firebaseUrl = config.prodFirebaseUrl;
            }
            else if (stage === 'v0_2') {
                bulkARN = config.prod2BulkARN;
                authToken = config.prod2Secret;
                firebaseUrl = config.prod2FirebaseUrl;
            }
            else {
                bulkARN = config.devBulkARN;
                authToken = config.devSecret;
                firebaseUrl = config.devFirebaseUrl;
            }
            
            var fromAddress = params.fromAddress;
            var verb = params.verb;
            var templateName = params.templateName;
            var templateBucket = params.templateBucket;
            var linkRoot = params.linkRoot;
            
            var notifyRequest = params.notifyRequest;
            var interests = null;
            var eventDetails = null;
            if (notifyRequest) {
                interests = notifyRequest.interests;
                eventDetails = notifyRequest.eventDetails;
            }
            


            NodeFire.setCacheSize(10);
            NodeFire.DEBUG = true;
            var db = new NodeFire(firebaseUrl);
            db.auth(authToken).then(function () {
                co(function*() {
                    if (verb === 'notifyPromotion') {

                        var _users = db.child("users");
                        var users = yield _users.get();
                        
                        if (users) {
                            var emails = {};
                            var nodups = {};
                            for (var i = 0; i < interests.length; i++) {
                                var _interestedUsers = db.child("userInterests/").orderByChild('interest').equalTo(interests[i]);
                                var interestedUsers = yield _interestedUsers.get();
                                if (interestedUsers) {
                                    var interestedUserKeys = Object.keys(interestedUsers);
                                    for (var j = 0; j < interestedUserKeys.length; j++) {
                                        var key = interestedUserKeys[j];
                                        var iu = interestedUsers[key].user;
                                        var user = users[iu];
                                        if (user && user.email) {
                                            nodups[user.email] = 1;
                                        }
                                    }
                                }
                            }
                            var addrs = Object.keys(nodups);
                            for (var k = 0; k < addrs.length; k++) {
                                var email = addrs[k];
                                var addressee = email.substring(0, email.lastIndexOf("@"));
                                var domain = email.substring(email.lastIndexOf("@") + 1);
                                if (emails[domain]) {
                                    emails[domain].push(addressee);
                                }
                                else {
                                    emails[domain] = [addressee];
                                }
                            }
                            var message = {};
                            
                            message.verb = verb;
                            message.stage = stage;
                            message.emails = emails;
                            message.fromAddress = fromAddress;
                            message.templateBucket = templateBucket;
                            message.templateName = templateName;
                            message.linkRoot = linkRoot;
                            message.notifyRequest = notifyRequest;
                            
                            var payload = {
                                default: JSON.stringify(message)
                            };
                            
                            yield publishSNS(bulkARN, payload, 'json');
                        }
                        context.succeed({});
                    }
                }).catch(function (err) {
                    console.log(err);
                    context.fail("Exception was thrown");
                });
            });
        }
        else {
            if (config.verbose) {
                console.log('No params object');
            }
            context.fail('Error: Invalid params');
        }
    }
};

function publishSNS(bulkARN, payload, messageStructure) {
    return new Promise(function (resolve, reject) {
        SNS.publish({
            TopicArn: bulkARN,
            Message: JSON.stringify(payload),
            MessageStructure: 'json'
        }, function (err, data) {
            if (err) {
                console.log(err);
                reject(err);
            }
            else {
                console.log("sent sns to " + bulkARN);
                resolve();
            }
        });
    });
}

