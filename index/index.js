var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment-timezone');

var config = require('./config.js');
var util = require('util');

//var S3 = require('./co-s3.js');

//var s3 = new S3();

var s3 = new aws.S3();
var SNS = new aws.SNS();

var nodemailer = require('nodemailer');
var ses = require('nodemailer-ses-transport');


var transporter = nodemailer.createTransport(ses({
    region: 'us-west-2',
    rateLimit: 20
}));

if (config.verbose) {
    console.log('started index.js');
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
    var stage = params.stage || 'dev';
    var result = '';
    if (params) {
        // Read options from the params.
        if (config.verbose) {
            console.log("Reading options from params:\n", util.inspect(params, { depth: 5 }));
        }
        
        var fromAddress = null;
        var firebaseUrl = null;
        var authToken = null;
        var templateBucket = '';
        var notifyUsersARN = null;
        var linkRoot = null;
        var algoliaApp = null;
        var algoliaAdminKey = null;
        if (stage === 'v0') {
            templateBucket = config.prodTemplateBucket;
            authToken = config.prodSecret;
            firebaseUrl = config.prodFirebaseUrl;
            fromAddress = config.prodFromAddress;
            notifyUsersARN = config.prodNotifyUsersARN;
            linkRoot = config.prodLinkRoot;
            algoliaApp = config.prodAlgoliaApp;
            algoliaAdminKey = config.prodAlgoliaAdminKey;
        }
        else if (stage === 'v0_2') {
            templateBucket = config.prod2TemplateBucket;
            authToken = config.prod2Secret;
            firebaseUrl = config.prod2FirebaseUrl;
            fromAddress = config.prodFromAddress;
            notifyUsersARN = config.prod2NotifyUsersARN;
            linkRoot = config.prod2LinkRoot;
            algoliaApp = config.prod2AlgoliaApp;
            algoliaAdminKey = config.prod2AlgoliaAdminKey;
        }
        else {
            templateBucket = config.devTemplateBucket;
            authToken = config.devSecret;
            firebaseUrl = config.devFirebaseUrl;
            fromAddress = config.fromAddress;
            notifyUsersARN = config.devNotifyUsersARN;
            linkRoot = config.devLinkRoot;
            algoliaApp = config.devAlgoliaApp;
            algoliaAdminKey = config.devAlgoliaAdminKey;
        }
        
        console.log(config);
       
        NodeFire.setCacheSize(10);
        NodeFire.DEBUG = true;
        var db = new NodeFire(firebaseUrl);
        db.auth(authToken).then(function () {
            if (config.verbose) {
                console.log('Auth succeeded');
            }
            co(function*() {
                if (params.type === 'event') {
                    yield processEvent(db, params, algoliaApp, algoliaAdminKey);
                }
                else if (params.type === 'post') {
                    yield processPost(db, params, algoliaApp, algoliaAdminKey);
                }
                else if (params.type === 'employeeProfile') {
                    yield processEmployeeProfile(db, params, algoliaApp, algoliaAdminKey);
                }
                else if (params.type === 'memberProfile') {
                    yield processMemberProfile(db, params, algoliaApp, algoliaAdminKey);
                }
                context.succeed({});
            }).catch(onerror);
        });
    }
    else {
        if (config.verbose) {
            console.log('No event object');
        }
        context.fail('Error: Invalid params');
    }
};

function isString(value) {
    return typeof value === 'string';
}

function setObjectAttribute(object, value, name, caps)
{
    if (object && value && name) {
        if (caps) {
            value = value.toUpperCase();
        }
        object[name] = value;
    }
}

function formatTime(epoch, fmt) {
    return moment(epoch).tz('America/Los_Angeles').format(fmt);
}

function formatRange(start, end, fmt) {
    var from = formatTime(start, fmt);
    var to = formatTime(end, fmt);
    return from + ' - ' + to;
}

function processPost(db, params, algoliaApp, algoliaAdminKey) {
    return co(function*() {
        if (config.verbose) {
            console.log('processPost');
        }
            
        var algoliasearch = require('algoliasearch');
        var client = algoliasearch(algoliaApp, algoliaAdminKey);
            
        var cardsIndex = client.initIndex('cards');
        if (params.verb === "remove") {
            yield cardsIndex.deleteObject(params.id);
        }
        else {
            var _post = db.child("posts/" + params.id);
            var post = yield _post.get();
            if (post) {
                post.objectName = "post";
                post.objectID = params.id;
                post.status = "Approved";
                yield cardsIndex.saveObject(post);
            }
        }
        
    }).catch(onerror);
}

function processEmployeeProfile(db, params, algoliaApp, algoliaAdminKey) {
    return co(function*() {
        if (config.verbose) {
            console.log('processEmployeeProfile');
        }
        
        var algoliasearch = require('algoliasearch');
        var client = algoliasearch(algoliaApp, algoliaAdminKey);
            
        var employeeProfilesIndex = client.initIndex('employeeProfiles');
            
        if (params.verb === "remove") {
            yield employeeProfilesIndex.deleteObject(params.id);
        }
        else {
            var _employee = db.child("employeeProfiles/" + params.id);
            var employee = yield _employee.get();
            if (employee && employee.department) {
                employee.objectID = params.id;
                yield employeeProfilesIndex.saveObject(employee);
            }
        }
    }).catch(onerror);
}

function processMemberProfile(db, params, algoliaApp, algoliaAdminKey) {
    return co(function*() {
        if (config.verbose) {
            console.log('processMemberProfile');
        }
        
       
                
        var algoliasearch = require('algoliasearch');
        var client = algoliasearch(algoliaApp, algoliaAdminKey);
                
        var memberProfilesIndex = client.initIndex('memberProfiles');
        var adminMemberProfilesIndex = client.initIndex('adminMemberProfiles');
                
        if (params.verb === "remove") {
            yield memberProfilesIndex.deleteObject(params.id);
            yield adminMemberProfilesIndex.deleteObject(params.id);
        }
        else {

            var _mpp = db.child("memberProfilePublics/" + params.id);
            var mpp = yield _mpp.get();
            if (mpp && mpp.user) {
                var adminMPP = clone(mpp);
                var _user = db.child('users/' + mpp.user);
                var user = yield _user.get();
                if (user) {
                    mpp.objectID = params.id;
                    adminMPP.objectID = params.id;

                    yield memberProfilesIndex.saveObject(mpp);
                    
                    adminMPP.memberNumber = user.memberNumber;
                    adminMPP.primaryMemberNumber = user.primaryMemberNumber;
                    yield adminMemberProfilesIndex.saveObject(adminMPP);
                }
            }
        }
    }).catch(onerror);
}

function clone(obj) {
    var copy;
    
    // Handle the 3 simple types, and null or undefined
    if (null == obj || "object" != typeof obj) return obj;
    
    // Handle Date
    if (obj instanceof Date) {
        copy = new Date();
        copy.setTime(obj.getTime());
        return copy;
    }
    
    // Handle Array
    if (obj instanceof Array) {
        copy = [];
        for (var i = 0, len = obj.length; i < len; i++) {
            copy[i] = clone(obj[i]);
        }
        return copy;
    }
    
    // Handle Object
    if (obj instanceof Object) {
        copy = {};
        for (var attr in obj) {
            if (obj.hasOwnProperty(attr)) copy[attr] = clone(obj[attr]);
        }
        return copy;
    }
    
    throw new Error("Unable to copy obj! Its type isn't supported.");
}

function processEvent(db, params, algoliaApp, algoliaAdminKey) {
    return co(function*() {
        if (config.verbose) {
            console.log('processEvent');
        }


            
        var algoliasearch = require('algoliasearch');
        var client = algoliasearch(algoliaApp, algoliaAdminKey);
            
        var cardsIndex = client.initIndex('cards');
        var eventSessionIndex = client.initIndex('eventSessions');

        if (params.verb === "remove") {
            yield cardsIndex.deleteObject(params.id);
            yield eventSessionIndex.deleteByQuery(params.id);
        }
        else { //add or update
            if (params.verb === 'update') {
                //the event sessions are recreated when the event is updated so remove so we can re-add
                yield eventSessionIndex.deleteByQuery(params.id);
            }
            
            var _event = db.child("events/" + params.id);
            var event = yield _event.get();
            if (event) {
                var interestName = '';
                var sessionIds = Object.keys(event.sessions);
                if (event.interests) {
                    var tags = [];
                    var interestIds = Object.keys(event.interests);
                    for (var i = 0; i < interestIds.length; i++) {
                        var _interest = db.child('interests/' + interestIds[i]);
                        var interest = yield _interest.get();
                        if (interest) {
                            if (interest.parent) {
                                tags.push(interest.name);
                            }
                            else {
                                interestName = interest.name;
                            }
                        }
                        else {
                            console.log('missing interest:' + interestIds[i]);
                        }
                    }
                    if (interestName === '') {
                        interestName = tags.join(", ");
                    }
                    else if (tags.length > 0) {
                        interestName = interestName + ' (' + tags.join(", ") + ')';
                    }
                }
                var dates = [];
                for (var s = 0; s < sessionIds.length; s++) {
                    var _session = db.child('sessions/' + sessionIds[s]);
                    var session = yield _session.get();
                    if (session) {
                        var locationName = '';
                        var _location = db.child('locations/' + session.location);
                        var location = yield _location.get();
                        if (location) {
                            locationName = location.name;
                        }
                        dates.push(session.date);
                        
                        var eventSession = {
                            name: event.title,
                            title: event.title,
                            date: session.date,
                            cancelBy: event.cancelBy,
                            registrationOpen: event.registrationOpen,
                            registrationClose: event.registrationClose,
                            duration: session.duration,
                            identifier: event.number,
                            location: session.location,
                            locationName: locationName,
                            status: event.status,
                            eventId: params.id,
                            sessionId: sessionIds[s],
                            interests: event.interests,
                            interestName: interestName,
                            objectID: sessionIds[s]
                        };
                        
                        yield eventSessionIndex.saveObject(eventSession);
                    }
                }
                event.dates = dates;
                event.objectName = "event";
                event.objectID = params.id;
                yield cardsIndex.saveObject(event);
            }
        }
    }).catch(onerror);
};


function sendEmail(fromAddress, to, subject, content, message, attachment) {
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

function publishSNS(notifyUsersARN, payload, messageStructure) {
    return new Promise(function (resolve, reject) {
        SNS.publish({
            TopicArn: notifyUsersARN,
            Message: JSON.stringify(payload),
            MessageStructure: 'json'
        }, function (err, data) {
            if (err) {
                console.log(err);
                reject(err);
            }
            resolve();
        });
    });
}

function getS3Object(templateBucket, templateName)
{
    return new Promise(function (resolve, reject) {
        s3.getObject({
            Bucket: templateBucket, 
            Key: templateName
        }, function (err, template) {
            if (err) {
                if (config.verbose) {
                    console.log(err, err.stack); // an error occurred
                }
                reject();
            }
            else {
                resolve(template);
            }
        });
    });
}

