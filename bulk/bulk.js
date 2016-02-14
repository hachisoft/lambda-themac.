var Promise = require('es6-promise').Promise;
var aws = require('aws-sdk');
var co = require('co');
var config = require('./config.js');
var util = require('util');

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
    if (params && params.Records && params.Records.length>=1) {
        var record = params.Records[0];
        if (record && record.Sns && record.Sns.Message)
        {
            params = JSON.parse(record.Sns.Message);
            
            /*if (config.verbose) {
                console.log("Reading nested entries from params:\n", util.inspect(params, { depth: 5 }));
            }*/

            var stage = params.stage || 'dev';
            var bulkARN = null;
            if (stage === 'v0') {
                bulkARN = config.prodBulkARN;
            }
            else if (stage === 'v0_2') {
                bulkARN = config.prod2BulkARN;
            }
            else {
                bulkARN = config.devBulkARN;
            }
            
            var fromAddress = params.fromAddress;
            var content = params.content;
            var subject = params.subject;
            var emails = params.emails;
            var draft = params.draft;
            co(function*() {
                var listKeys = Object.keys(emails);
                var remainder = listKeys.length - config.sendThreshold;
                
                if (draft) {
                    yield sendEmail(fromAddress, draft, subject, content, null, null);
                }

                for (var j = 0; j < listKeys.length && j<config.sendThreshold; j++) {
                    var key = listKeys[j];
                    var email = emails[key];
                    if (config.production) {
                        yield sendEmail(fromAddress, email, subject, content, null, null);
                    }
                    else {
                        console.log("fake email " + email);
                    }
                    delete emails[key];
                }
                if (remainder > 0) {
                    var message = {};
                    message.emails = emails;
                    message.fromAddress = fromAddress;
                    message.subject = subject;
                    message.content = content;
                    message.stage = stage;
                    
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
            }).catch(function (err) {
                console.log(err);
                context.fail("Exception was thrown");
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

