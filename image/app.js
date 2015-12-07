var async = require('async');
var AWS = require('aws-sdk');
var Firebase = require('firebase');
var NodeFire = require('nodefire');
var moment = require('moment');
var gm = require('gm')
  , imageMagick = gm.subClass({ imageMagick: true });
var util = require('util');
var config = require('./config.js');
// constants
var imageSizes = [80, 160, 320, 453, 720];
var thumbSizes = [80];

// get reference to S3 client 
var s3 = new AWS.S3();

exports.handler = function (event, context) {
    
    var stage = event.stage || 'dev';
    
    var firebaseUrl = null;
    var authToken = null;
    var templateBucket = config.templateBucket;
    if (stage !== 'dev') {
        authToken = config.prodSecret;
        firebaseUrl = config.prodFirebaseUrl;
    }
    else {
        templateBucket = 'dev.' + templateBucket;
        authToken = config.devSecret;
        firebaseUrl = config.devFirebaseUrl;
    }
    
    console.log(config);
    
    // Read options from the event.
    console.log("Reading options from event:\n", util.inspect(event, { depth: 5 }));
    
    var download = require('./get.js');
    var dest = '/tmp/temp';
    
    download(event.url, dest, function (err) {
        if (err) {
            return console.error('unable to download image ' + err);
        }
        else {
            var imageType = '.png';
            var contentType = 'image/png';
            var original = imageMagick(dest);
            original.size(function (err, size) {
                
                if (err)
                    return console.error(err);
                var square = false;
                var sizes = null;
                var identifier = null;
                if (event.user) {
                    sizes = thumbSizes;
                    templateBucket = templateBucket + '/' + event.user;
                    square = true;
                }
                else if (event.image) {
                    sizes = imageSizes;
                    templateBucket = templateBucket+'/'+event.image;
                }
                
                var keys = [];
                //transform, and upload to a different S3 bucket.
                async.each(sizes,
                    function (max_size, callback) {
                    resize_photo(size, max_size,square,imageType, original, contentType, callback, stage,keys, templateBucket);
                },
                    function (err) {
                    if (err) {
                        context.done();   
                    } else {
                        NodeFire.setCacheSize(10);
                        NodeFire.DEBUG = true;
                        var db = new NodeFire(firebaseUrl);
                        db.auth(authToken).then(function () {
                            console.log('Auth succeeded');
                            if (event.user) {
                                var _user = db.child('users/' + event.user);
                                if (_user) {
                                    _user.get().then(function (user) {
                                        if (keys.length === 1) {
                                            user.thumbId = keys[0];
                                            user.photoId = event.url;
                                            _user.set(user).then(function (r) {
                                                context.done();
                                            });
                                        }
                                    });
                                }
                            }
                            else if (event.image) {
                                var _image = db.child('images/' + event.image);
                                if (_image) {
                                    _image.get().then(function (image) {
                                        if (keys.length > 4) {
                                            image.small = keys[0];
                                            image.medium = keys[1];
                                            image.large = keys[2];
                                            image.larger = keys[3];
                                            image.largest = keys[4];
                                            image.original = event.url;
                                            _image.set(image).then(function (r) {
                                                context.done();
                                            });
                                        }
                                    });
                                }
                            }
                            
                        });
                    }
                    
                    
                });
            });
        }
    });  
};

//wrap up variables into an options object
var resize_photo = function (size, max_size, square, imageType, original, contentType, done, stage, keys, bucket) {
    
    var key = null;
    var uniqueId = '_' + Math.random().toString(36).substr(2, 16);
    // transform, and upload to a different S3 bucket.
    async.waterfall([
        function presign(next)
        {
            var params = {
                Bucket: bucket, 
                Key: uniqueId,
                Expires: 473040000
            };
            s3.getSignedUrl('getObject', params, function (err, url) {
                console.log("The URL is", url);
                key = url;
                next(err);
            });
        },
        function transform(next) {
            
            
            // Infer the scaling factor to avoid stretching the image unnaturally.
            var width = max_size;
            var height = max_size;
            if (square) {
                if (size.width>size.height) {
                    original.shave((size.width - size.height) / 2, 0, 0);
                }
                else if (size.width < size.height) {
                    original.shave(0,(size.height - size.width) / 2, 0);
                }
            }
            else {
                var scalingFactor = Math.min(
                    max_size / size.width,
                    max_size / size.height
                );
                width = scalingFactor * size.width;
                height = scalingFactor * size.height;
            }
            
            
            // Transform the image buffer in memory.
            original.resize(width, height)
                .toBuffer(imageType, function (err, buffer) {
                
                if (err) {
                    next(err);
                } else {
                    next(null, buffer);
                }
            });

        },
        function upload(data, next) {
            // Stream the transformed image to a different S3 bucket.
            s3.putObject({
                Bucket: bucket,
                Key: uniqueId,
                Body: data,
                ContentType: contentType
            },
                next);
        }
    ], function (err) {
        
        console.log('finished resizing ' + bucket + '/' + key);
        
        if (err) {
            console.error(err)
            ;
        } else {
            console.log(
                'Successfully resized ' + key
            );
            keys.push(key);
        }
        
        done(err);
    }
    );
};
