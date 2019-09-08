var util = require('util');
var helper = require('./connection.js');
var logger = helper.getLogger('Queryinfo');

var queryinfo= async function(username,orgName){
    var client = await helper.getClientForOrg(orgName, username,peers);
    log.info(orgName,username,peers)
    var channel = client.getChannel("mychannel1");
    if(!channel) {
        let message = util.format('##### queryChaincode - Channel %s was not defined in the connection profile', channelName);
        logger.error(message);
        throw new Error(message);
    }
    var request = {
        target : peers
    };

    let responses = await channel.queryInfo(request);
    log.info(responses.toString());
    return responses;

}
exports.queryinfo = queryinfo;