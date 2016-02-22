var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var co = require('co');
var moment = require('moment-timezone');
var config = require('./config.js');
var util = require('util');

var s3 = new aws.S3();
var SNS = new aws.SNS();

var nodemailer = require('nodemailer');
var ses = require('nodemailer-ses-transport');

var transporter = nodemailer.createTransport(ses({
    region: 'us-west-2',
    rateLimit: 20
}));

if (config.verbose) {
    console.log('started bulk.js');
}

exports.handler = function (params, context) {
    var result = '';
    if (params && params.Records && params.Records.length >= 1) {
        var record = params.Records[0];
        if (record && record.Sns && record.Sns.Message) {
            params = JSON.parse(record.Sns.Message);
            
            /*if (config.verbose) {
                console.log("Reading nested entries from params:\n", util.inspect(params, { depth: 5 }));
            }*/

            var stage = params.stage || 'dev';
            var bulkARN = null;
            var authToken = null;
            var firebaseUrl = null;
            
            var verb = params.verb;
            var fromAddress = params.fromAddress;
            var emails = params.emails;
            var templateBucket = params.templateBucket;
            var templateName = params.templateName;
            var linkRoot = params.linkRoot;
            
            var notifyRequest = params.notifyRequest;
            var draft = notifyRequest.draft;
            var subject = notifyRequest.subject;
            
            if (stage === 'v0') {
                authToken = config.prodSecret;
                firebaseUrl = config.prodFirebaseUrl;
                bulkARN = config.prodBulkARN;
            }
            else if (stage === 'v0_2') {
                authToken = config.prod2Secret;
                firebaseUrl = config.prod2FirebaseUrl;
                bulkARN = config.prod2BulkARN;
            }
            else {
                authToken = config.devSecret;
                firebaseUrl = config.devFirebaseUrl;
                bulkARN = config.devBulkARN;
            }
            
            NodeFire.setCacheSize(10);
            var db = new NodeFire(firebaseUrl);
            db.auth(authToken).then(function () {
                if (config.verbose) {
                    console.log("bulk firebase auth succeeded");
                }
                co(function*() {
                    
                    var template = yield getS3Object(templateBucket, templateName);
                    if (template) {
                        
                        var content = yield getContent(db, verb, template, notifyRequest, linkRoot);
                        
                        if (notifyRequest.cc) {
                            yield sendEmail(fromAddress, notifyRequest.cc, subject, content, null, null);
                            delete notifyRequest['cc'];
                        }
                        
                        if (!draft) {
                            var sentMail = [];
                            var domains = Object.keys(emails);
                            var count = 0;
                            for (var j = 0; j < domains.length; j++) {
                                var domain = domains[j];
                                var addressees = emails[domain];
                                var breakPoint = null;
                                for (var k = 0; k < addressees.length; k++) {
                                    if (count < config.sendThreshold) {
                                        var addressee = addressees[k];
                                        var email = addressee + '@' + domain;
                                        if (config.production) {
                                            yield sendEmail(fromAddress, email, subject, content, null, null);
                                        }
                                        else {
                                            sentMail.push(email);
                                        }
                                        count++;
                                    }
                                    else {
                                        breakPoint = k;
                                        var addressee = addressees[k];
                                        var email = addressee + '@' + domain;
                                        break;
                                    }
                                }
                                if (breakPoint) {
                                    emails[domain].splice(0, breakPoint);
                                    break;
                                }
                                
                                delete emails[domain];
                            }
                            
                            if (config.verbose) {
                                console.log("sent email:"+sentMail.length);
                                console.log(sentMail);
                            }
                            
                            var domainsLeft = Object.keys(emails);

                            if (domainsLeft.length > 0) {
                                var message = {};
                                message.stage = stage;
                                message.verb = verb;
                                message.emails = emails;
                                message.fromAddress = fromAddress;
                                message.notifyRequest = notifyRequest;
                                message.templateBucket = templateBucket;
                                message.templateName = templateName;
                                message.linkRoot = linkRoot;
                                
                                var payload = {
                                    default: JSON.stringify(message)
                                };
                                
                                SNS.publish({
                                    TopicArn: bulkARN,
                                    Message: JSON.stringify(payload),
                                    MessageStructure: 'json'
                                }, function (err, data) {
                                    if (err) {
                                        console.log(err);
                                        context.fail(err);
                                    }
                                    context.succeed({});
                                });
                            }
                            else {
                                context.succeed({});
                            }
                        }
                        else {
                            context.succeed({});
                        }
                    }
                    else {
                        context.fail("missing template");
                    }
                }).catch(function (err) {
                    console.log(err);
                    context.fail("Exception was thrown");
                });
            });
        }
    }
    else {
        if (config.verbose) {
            console.log('No params object');
        }
        context.fail('Error: Invalid params');
    }
};

function isString(value) {
    return typeof value === 'string';
}

function setObjectAttribute(object, value, name, caps) {
    if (object && value && name) {
        if (caps) {
            value = value.toUpperCase();
        }
        object[name] = value;
    }
}

function getPPCSS(status) {
    if (status === 'Low') {
        return "fill: none; border-color: #8EC641;";
    }
    else if (status === 'Medium') {
        return "background-image:url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMCcgaGVpZ2h0PScxMCc+DQogIDxsaW5lIHkyPSItMSIgeDI9IjEiIHkxPSIxIiB4MT0iLTEiIHN0cm9rZT0iI0ZCQjA0MSIgLz4NCiAgPGxpbmUgeTI9Ii0xIiB4Mj0iMTEiIHkxPSIxMSIgeDE9Ii0xIiBzdHJva2U9IiNGQkIwNDEiIC8+DQogIDxsaW5lIHkyPSI5IiB4Mj0iMTEiIHkxPSIxMSIgeDE9IjkiIHN0cm9rZT0iI0ZCQjA0MSIgLz4NCjwvc3ZnPg==); background-repeat:repeat; border-color:#FBB041;";
    }
    else {
        return "background-image:url(data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMCcgaGVpZ2h0PScxMCc+DQogIDxsaW5lIHkyPSItMSIgeDI9IjEiIHkxPSIxIiB4MT0iLTEiIHN0cm9rZT0iI0NGMEEyQyIgLz4NCiAgPGxpbmUgeTI9Ii0xIiB4Mj0iMTEiIHkxPSIxMSIgeDE9Ii0xIiBzdHJva2U9IiNDRjBBMkMiIC8+DQogIDxsaW5lIHkyPSItMSIgeDI9IjYiIHkxPSI2IiB4MT0iLTEiIHN0cm9rZT0iI0NGMEEyQyIgLz4NCiAgPGxpbmUgeTI9IjkiIHgyPSIxMSIgeTE9IjExIiB4MT0iOSIgc3Ryb2tlPSIjQ0YwQTJDIiAvPg0KICA8bGluZSB5Mj0iNCIgeDI9IjExIiB5MT0iMTEiIHgxPSI0IiBzdHJva2U9IiNDRjBBMkMiIC8+DQo8L3N2Zz4=); background-repeat: repeat; border-color: #CF0A2C;";
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

function getContent(db, verb, template, notifyRequest, linkRoot)
{
    return co(function*() {
        var content = null;
        if (verb === 'emergency' || verb === 'closure') {
            var mark = require('markup-js');
            
            var details = {
                title: notifyRequest.title,
                description: notifyRequest.description,
            };
            
            if (notifyRequest.sentBy) {
                details.sentBy = notifyRequest.sentBy;
            }
            
            if (notifyRequest.image) {
                details.image = notifyRequest.image;
            }
            
            if (notifyRequest.memberName) {
                details.memberName = notifyRequest.memberName;
            }
            
            if (template) {
                content = mark.up(template, details);
            }
            
            return content;
        }
        else if (verb==='notifyPromotion'){
            var eventDetails = notifyRequest.eventDetails;
            var includeParkingProjection = notifyRequest.includeParkingProjection;
            var contactInfo = notifyRequest.contactInfo;
            var additionalInfo = notifyRequest.additionalInformation;
            var specialCaption = notifyRequest.specialCaption;
            if (eventDetails && eventDetails.length > 0 && template) {
                
                var details = {};
                
                if (includeParkingProjection) {
                    var today = moment();
                    var sunday = today.startOf('week').valueOf();
                    var saturday = today.endOf('week').valueOf();
                    var _parkingProjections = db.child("parkingProjections/").orderByChild('date').startAt(sunday).endAt(saturday);
                    var parkingProjections = yield _parkingProjections.get();
                    if (parkingProjections) {
                        var ppKeys = Object.keys(parkingProjections);
                        for (var l = 0; l < ppKeys.length; l++) {
                            var key = ppKeys[l];
                            var pp = parkingProjections[key];
                            if (pp) {
                                setObjectAttribute(details, formatTime(pp.date, "DD"), "day" + l + "text", false);
                                setObjectAttribute(details, formatTime(pp.date, "MMM"), "day" + l + "month", true);
                                setObjectAttribute(details, formatTime(pp.date, "ddd"), "day" + l, true);
                                setObjectAttribute(details, getPPCSS(pp.statusEarly), "day" + l + "am", false);
                                setObjectAttribute(details, getPPCSS(pp.statusMidDay), "day" + l + "md", false);
                                setObjectAttribute(details, getPPCSS(pp.statusLate), "day" + l + "pm", false);
                            }
                        }
                        details.parkingForecast = true;
                    }
                }
                
                if (eventDetails.length >= 1) {
                    var eventDetail = eventDetails[0];
                    if (eventDetail) {
                        details.eventTitle1 = eventDetail.title;
                        details.eventDescription1 = eventDetail.description;
                        var _event1 = db.child('events/' + eventDetail.id);
                        var event1 = yield _event1.get();
                        if (event1) {
                            if (event1.largest) {
                                details.image1 = event1.largest;
                            }
                            if (event1.startDate && event1.endDate) {
                                details.eventDay1 = formatTime(event1.startDate, 'dddd MMM. D');
                                details.eventDateTime1 = formatRange(event1.startDate, event1.endDate, 'h:mm A');
                            }
                        }
                        details.eventLink1 = linkRoot + "/event/" + eventDetail.id;
                    }
                }
                if (eventDetails.length >= 2) {
                    var eventDetail = eventDetails[1];
                    if (eventDetail) {
                        details.eventTitle2 = eventDetail.title;
                        details.eventDescription2 = eventDetail.description;
                        var _event2 = db.child('events/' + eventDetail.id);
                        var event2 = yield _event2.get();
                        if (event2) {
                            if (event2.largest) {
                                details.image2 = event2.largest;
                            }
                            if (event1.startDate && event1.endDate) {
                                details.eventDay2 = formatTime(event2.startDate, 'dddd MMM. D');
                                details.eventDateTime2 = formatRange(event2.startDate, event2.endDate, 'h:mm A');
                            }
                        }
                        details.eventLink2 = linkRoot + "/event/" + eventDetail.id;
                    }
                }
                if (eventDetails.length >= 3) {
                    var eventDetail = eventDetails[2];
                    if (eventDetail) {
                        details.eventTitle3 = eventDetail.title;
                        details.eventDescription3 = eventDetail.description;
                        var _event3 = db.child('events/' + eventDetail.id);
                        var event3 = yield _event3.get();
                        if (event3) {
                            if (event3.largest) {
                                details.image3 = event3.largest;
                            }
                            if (event3.startDate && event3.endDate) {
                                details.eventDay3 = formatTime(event3.startDate, 'dddd MMM. D');
                                details.eventDateTime3 = formatRange(event3.startDate, event3.endDate, 'h:mm A');
                            }
                        }
                        details.eventLink3 = linkRoot + "/event/" + eventDetail.id;
                    }
                }
                if (eventDetails.length >= 4) {
                    var eventDetail = eventDetails[3];
                    if (eventDetail) {
                        details.eventTitle4 = eventDetail.title;
                        details.eventDescription4 = eventDetail.description;
                        var _event4 = db.child('events/' + eventDetail.id);
                        var event4 = yield _event4.get();
                        if (event4) {
                            if (event4.largest) {
                                details.image4 = event4.largest;
                            }
                            if (event4.startDate && event4.endDate) {
                                details.eventDay4 = formatTime(event4.startDate, 'dddd MMM. D');
                                details.eventDateTime4 = formatRange(event4.startDate, event4.endDate, 'h:mm A');
                            }
                        }
                        details.eventLink4 = linkRoot + "/event/" + eventDetail.id;
                    }
                }
                
                if (linkRoot) {
                    details.parkingLink = linkRoot + "/parking";
                }
                
                if (contactInfo) {
                    details.contactInfo = contactInfo;
                }
                
                if (additionalInfo) {
                    details.additionalInfo = additionalInfo;
                }
                
                if (specialCaption) {
                    details.specialCaption = specialCaption;
                }
                
                /*if (config.verbose) {
                    console.log(details);
                }*/
                
                var mark = require('markup-js');
                
                
                if (template) {
                    try {
                        content = mark.up(template, details);
                    }
                    catch (e) {
                        console.log(e);
                    }
                }
            }
            return content;
        }
    }).catch(function (err) {
        console.log(err);
    });
}

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
                console.log('email sent ' + to);
            }
            resolve();
        });
    });
}

function getS3Object(templateBucket, templateName) {
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
                resolve(template.Body.toString());
            }
        });
    });
}

