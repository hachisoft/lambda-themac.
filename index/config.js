"use strict";

var config = {
    "devContentBucket" : "dev.themac.content.images",
    "prodContentBucket" : "themac.content.images",
    "prod2ContentBucket" : "themac-2.content.images",
    "devProfileBucket" : "dev.themac.profiles.images",
    "prodProfileBucket" : "themac.profiles.images",
    "prod2ProfileBucket" : "themac-2.profiles.images",
    "devTemplateBucket" : "dev.themac.email.templates",
    "prodTemplateBucket" : "themac.email.templates",
    "prod2TemplateBucket" : "themac-2.email.templates",
    "prodFromAddress": "MAC <webmaster@themac.com>",
    "fromAddress": "contact@hachisoft.com",
    "prod2FirebaseUrl": 'https://macdata-2.firebaseio.com/',
    "prodFirebaseUrl": 'https://sizzling-inferno-283.firebaseio.com/',
    "devFirebaseUrl": 'https://luminous-heat-7934.firebaseio.com/',
    "devSecret": 'yIrmmj2CttjtCOGoPJZKRLVV24rkKaZeo4sm1gUh',
    "prodSecret": 'QE9kZaptDGsWBIBH1bQG87SJaOGQQFDsh5EWOwPF',
    "prod2Secret": 'R1392k8CocUwpqHrKsjGsI19mrie7khPupa5MyHx',
    "prodS3Secret": 'qk46uq70LwWjmkajun5e1fMcpF4OJnd0vryesoVB',
    "devS3Secret": 'Hn/MqHv7XxHcTv5p5MngKwzk1CwnbkFICN670rz7',
    "prod2S3Secret": 'qk46uq70LwWjmkajun5e1fMcpF4OJnd0vryesoVB',
    "verbose": true,
    "feedbackEmails": [
        'msdedwards@hachisoft.com',
        'czoucha@themac.com'
    ],
    "childcareEmails": [
        'msdedwards@hachisoft.com',
        'czoucha@themac.com'
    ],
    "eventCreationUsers": ['830830'],
    "devNotifyUsersARN": "arn:aws:sns:us-west-2:172166497234:notify-users",
    "prod2NotifyUsersARN": "arn:aws:sns:us-west-2:907623002484:notify-users",
    "prodNotifyUsersARN": "arn:aws:sns:us-west-2:907623002484:notify-users",
    "devLinkRoot": "http://localhost:4200",
    "prod2LinkRoot": "https://macdata-2.firebaseapp.com",
    "prodLinkRoot": "https://sizzling-inferno-283.firebaseapp.com",
    "devAlgoliaApp": "8DPGTBYS6E",
    "devAlgoliaAdminKey": "caa2653d526bacda7d15ec00b90582a4",
    "prodAlgoliaApp": "MJ7S7WIVSD",
    "prodAlgoliaAdminKey": "f369797fe6f9f0cbdab22fd6d560ec4d",
    "prod2AlgoliaApp": "VMP51ISYEX",
    "prod2AlgoliaAdminKey": "7832711cf59a8b5097caa3f158912cc9",
}
module.exports = config