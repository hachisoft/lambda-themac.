var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var co = require('co');
var config = require('./config.js');
var util = require('util');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var moment = require('moment');


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

            NodeFire.setCacheSize(10);
            NodeFire.DEBUG = true;
            var db = new NodeFire(firebaseUrl);
            db.auth(authToken).then(function () {
                co(function*() {
                    if (verb === 'closure') {
                        yield processClosureNotification(db, verb, stage, bulkARN, fromAddress, linkRoot, notifyRequest, templateName, templateBucket);
                    }
                    else if (verb === 'emergency') {
                        yield processEmergencyNotification(db, verb, stage, bulkARN, fromAddress, linkRoot, notifyRequest, templateName, templateBucket);
                    }
                    else if (verb === 'notifyPromotion') {
                        yield processNotifyPromotion(db, verb, stage, bulkARN, fromAddress, linkRoot, notifyRequest, templateName, templateBucket);
                    }
                    context.succeed({});
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

function fillEmails(nodups, emails)
{
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
    return addrs.length > 0;
}

function addAuditEntry(admin, adminName, type, name, memberNumber, sentEmail, sentNotification, interests, locations)
{
    var auditEntry = {
            'sentEmail': sentEmail,
            'sentNotification': sentNotification,
            'notifiedName': name,
            'notifiedMember': memberNumber,
            'type': type,
        'timestamp': moment().valueOf(),
    };
    if (admin) {
        auditEntry.admin = admin;
    }
    if (adminName) {
        auditEntry.adminName = adminName;
    }
    if (interests) {
        auditEntry.interests = interests;
    }
    if (locations) {
        auditEntry.locations = locations;
    }
    return auditEntry;
}

function processNotifyPromotion(db, verb, stage, bulkARN, fromAddress, linkRoot, notifyRequest, templateName, templateBucket)
{
    return co(function*() {
        var interests = null;
        var locations = null;
        var eventDetails = null;
        var admin = null;
        var adminName = null;
        var type = null;
        if (notifyRequest) {
            interests = notifyRequest.interestIds;
            eventDetails = notifyRequest.eventDetails;
            admin = notifyRequest.admin;
            adminName = notifyRequest.adminName;
            type = notifyRequest.type;
        }
        
        var _users = db.child("users");
        var users = yield _users.get();
        
        if (users) {
            var auditEntries = {};
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
                            var name = user.firstName + ' ' + user.lastName;
                            auditEntries[iu]=addAuditEntry(admin, adminName, type, name, user.memberNumber, user.email, false, interests, locations);
                            nodups[user.email] = 1;
                        }
                    }
                }
            }
            
            if (fillEmails(nodups, emails)) {
                
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

            yield writeAuditEntries(db, auditEntries);
        }
    }).catch(function (err) {
        if (config.verbose) {
            console.error(err.stack);
        }
    });
}

function processClosureNotification(db, verb, stage, bulkARN, fromAddress, linkRoot, notifyRequest, templateName, templateBucket) {
    return co(function*() {
        if (config.verbose) {
            console.log('processClosureNotification');
            console.log({
                'notification_id': notifyRequest.notificationId,
                'fromAddress': fromAddress,
                'title': notifyRequest.title,
                'description': notifyRequest.description,
                'sentBy': notifyRequest.sentBy,
                'image': notifyRequest.image,
                'templateBucket': templateBucket,
                'templateName': templateName
            });
        }
        var promises = [];
        var _responses = db.child("notificationResponses/").orderByChild('notification').equalTo(notifyRequest.notificationId);
        var responses = yield _responses.get();
        if (responses) {
            var responseKeys = Object.keys(responses);
            for (var i = 0; i < responseKeys.length; i++) {
                var key = responseKeys[i];
                var _resp = db.child('notificationResponses/' + key);
                promises.push(_resp.remove());
            }
        }
        
        var admin = null;
        var adminName = null;
        var type = null;
        var interests = null;
        var locations = null;
        if (notifyRequest) {
            interests = notifyRequest.interestIds;
            locations = notifyRequest.locationIds;
            admin = notifyRequest.admin;
            adminName = notifyRequest.adminName;
            type = notifyRequest.type;
        }
        
        var _users = db.child("users");
        var users = yield _users.get();
        
        if (users) {
            var auditEntries = {};
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
                        if (user) {
                            var sentNotification = false;
                            var sentEmail = null;
                            if (user.email && user.sendEmailConfirmation) {
                                sentEmail = user.email;
                                nodups[user.email] = 1;
                            }
                            if (user.sendNotificationConfirmation) {
                                sentNotification = true;
                                var _numNewNotifications = db.child('users/' + iu + '/numNewNotifications');
                                yield _numNewNotifications.transaction(function (numNewNotifications) {
                                    if (numNewNotifications === null) {
                                        return 1;
                                    }
                                    else {
                                        return numNewNotifications + 1;
                                    }
                                });
                            }
                            var name = user.firstName + ' ' + user.lastName;
                            auditEntries[iu]=addAuditEntry(admin, adminName, type, name, user.memberNumber, sentEmail, sentNotification, interests, locations);
                        }
                    }
                }
            }
            
            if (fillEmails(nodups, emails)) {
                
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
            yield writeAuditEntries(db, auditEntries);
        }
        yield promises;
    }).catch(function (err) {
        if (config.verbose) {
            console.error(err.stack);
        }
    });
};

function processEmergencyNotification(db, verb, stage, bulkARN, fromAddress, linkRoot, notifyRequest, templateName, templateBucket) {
    return co(function*() {
        if (config.verbose) {
            console.log('processEmergencyNotification');
            console.log({
                'notification_id': notifyRequest.id,
                'fromAddress': fromAddress,
                'title': notifyRequest.title,
                'description': notifyRequest.description,
                'sentBy': notifyRequest.sentBy,
                'image': notifyRequest.image,
                'templateBucket': templateBucket,
                'templateName': templateName
            });
        }
        
        var admin = null;
        var adminName = null;
        var type = null;
        if (notifyRequest) {
            admin = notifyRequest.admin;
            adminName = notifyRequest.adminName;
            type = notifyRequest.type;
        }

        var promises = [];
        var auditEntries = {};
        
        if (config.verbose) {
            console.log('notificationResponses');
        }
        var _responses = db.child("notificationResponses/").orderByChild('notification').equalTo(notifyRequest.id);
        var responses = yield _responses.get();
        if (responses) {
            if (config.verbose) {
                console.log('responses');
            }
            var responseKeys = Object.keys(responses);
            for (var i = 0; i < responseKeys.length; i++) {
                var key = responseKeys[i];
                var _resp = db.child('notificationResponses/' + key);
                promises.push(_resp.remove());
            }
        }
        
        var _notifyUsers = db.child('users/').orderByChild('sendNotificationConfirmation').equalTo(true);
        var notifyUsers = yield _notifyUsers.get();
        if (notifyUsers) {
            
            var notifyUsersKeys = Object.keys(notifyUsers);
            for (var ui = 0; ui < notifyUsersKeys.length; ui++) {
                var key = notifyUsersKeys[ui];
                var notifyUser = notifyUsers[key];
                if (notifyUser) {
                    var _numNewNotifications = db.child('users/' + key + '/numNewNotifications');
                    yield _numNewNotifications.transaction(function (numNewNotifications) {
                        if (numNewNotifications === null) {
                            return 1;
                        }
                        else {
                            return numNewNotifications + 1;
                        }
                    });
                    
                    var name = notifyUser.firstName + ' ' + notifyUser.lastName;
                    auditEntries[key] = addAuditEntry(admin,adminName,type,name,notifyUser.memberNumber,null,true,null, null);
                }
            }
        }

        var _notifyEmails = db.child('users/').orderByChild('sendEmailConfirmation').equalTo(true);
        var notifyEmails = yield _notifyEmails.get();
        if (notifyEmails) {
            var nodups = {};
            var emails = {};
            var notifyEmailKeys = Object.keys(notifyEmails);
            
            for (var ui = 0; ui < notifyEmailKeys.length; ui++) {
                var key = notifyEmailKeys[ui];
                var user = notifyEmails[key];
                if (user && user.email) {
                    if (auditEntries[key]) {
                        auditEntries[key].sentMail = user.email;
                    }
                    else {
                        var name = user.firstName + ' ' + user.lastName;
                        auditEntries[key] = addAuditEntry(admin, adminName, type, name, user.memberNumber, user.email, false, null, null);
                    }
                    nodups[user.email] = 1;
                }
            }
            
            if (fillEmails(nodups, emails)) {
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
            yield writeAuditEntries(db,auditEntries);
        }
        yield promises;
    }).catch(function (err) {
        if (config.verbose) {
            console.error(err.stack);
        }
    });
}

function writeAuditEntries(db,auditEntries)
{
    return co(function*() {
        
        var atomicWrite = {};
        
        var keys = Object.keys(auditEntries);
        for (var k = 0; k < keys.length; k++) {
            var key = db.generateUniqueKey();
            var path = 'auditNotifications/' + key;
            atomicWrite[path] = auditEntries[keys[k]];
        }
        yield db.update(atomicWrite);
    });
}

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

