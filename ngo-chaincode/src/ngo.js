/*
# Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# 
# Licensed under the Apache License, Version 2.0 (the "License").
# You may not use this file except in compliance with the License.
# A copy of the License is located at
# 
#     http://www.apache.org/licenses/LICENSE-2.0
# 
# or in the "license" file accompanying this file. This file is distributed 
# on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either 
# express or implied. See the License for the specific language governing 
# permissions and limitations under the License.
#
*/

'use strict';
const shim = require('fabric-shim');
const util = require('util');

/************************************************************************************************
 * 
 * GENERAL FUNCTIONS 
 * 
 ************************************************************************************************/

/**
 * Executes a query using a specific key
 * 
 * @param {*} key - the key to use in the query
 */
async function queryByKey(stub, key) {
  console.log('============= START : queryByKey ===========');
  console.log('##### queryByKey key: ' + key);

  let resultAsBytes = await stub.getState(key); 
  if (!resultAsBytes || resultAsBytes.toString().length <= 0) {
    throw new Error('##### queryByKey key: ' + key + ' does not exist');
  }
  console.log('##### queryByKey response: ' + resultAsBytes);
  console.log('============= END : queryByKey ===========');
  return resultAsBytes;
}

/**
 * Executes a query based on a provided queryString
 * 
 * I originally wrote this function to handle rich queries via CouchDB, but subsequently needed
 * to support LevelDB range queries where CouchDB was not available.
 * 
 * @param {*} queryString - the query string to execute
 */
async function queryByString(stub, queryString) {
  console.log('============= START : queryByString ===========');
  console.log("##### queryByString queryString: " + queryString);

  // CouchDB Query
  // let iterator = await stub.getQueryResult(queryString);

  // Equivalent LevelDB Query. We need to parse queryString to determine what is being queried
  // In this chaincode, all queries will either query ALL records for a specific docType, or
  // they will filter ALL the records looking for a specific NGO, Donor, Donation, etc. So far, 
  // in this chaincode there is a maximum of one filter parameter in addition to the docType.
  let docType = "";
  let startKey = "";
  let endKey = "";
  let jsonQueryString = JSON.parse(queryString);
  if (jsonQueryString['selector'] && jsonQueryString['selector']['docType']) {
    docType = jsonQueryString['selector']['docType'];
    startKey = docType + "0";
    endKey = docType + "z";
  }
  else {
  throw new Error('##### queryByString - Cannot call queryByString without a docType element: ' + queryString);
}

  let iterator = await stub.getStateByRange(startKey, endKey);

  // Iterator handling is identical for both CouchDB and LevelDB result sets, with the 
  // exception of the filter handling in the commented section below
  let allResults = [];
  while (true) {
    let res = await iterator.next();

    if (res.value && res.value.value.toString()) {
      let jsonRes = {};
      console.log('##### queryByString iterator: ' + res.value.value.toString('utf8'));

      jsonRes.Key = res.value.key;
      try {
        jsonRes.Record = JSON.parse(res.value.value.toString('utf8'));
      } 
      catch (err) {
        console.log('##### queryByString error: ' + err);
        jsonRes.Record = res.value.value.toString('utf8');
      }
      // ******************* LevelDB filter handling ******************************************
      // LevelDB: additional code required to filter out records we don't need
      // Check that each filter condition in jsonQueryString can be found in the iterator json
      // If we are using CouchDB, this isn't required as rich query supports selectors
      let jsonRecord = jsonQueryString['selector'];
      // If there is only a docType, no need to filter, just return all
      console.log('##### queryByString jsonRecord - number of JSON keys: ' + Object.keys(jsonRecord).length);
      if (Object.keys(jsonRecord).length == 1) {
        allResults.push(jsonRes);
        continue;
      }
      for (var key in jsonRecord) {
        if (jsonRecord.hasOwnProperty(key)) {
          console.log('##### queryByString jsonRecord key: ' + key + " value: " + jsonRecord[key]);
          if (key == "docType") {
            continue;
          }
          console.log('##### queryByString json iterator has key: ' + jsonRes.Record[key]);
          if (!(jsonRes.Record[key] && jsonRes.Record[key] == jsonRecord[key])) {
            // we do not want this record as it does not match the filter criteria
            continue;
          }
          allResults.push(jsonRes);
        }
      }
      // ******************* End LevelDB filter handling ******************************************
      // For CouchDB, push all results
      // allResults.push(jsonRes);
    }
    if (res.done) {
      await iterator.close();
      console.log('##### queryByString all results: ' + JSON.stringify(allResults));
      console.log('============= END : queryByString ===========');
      return Buffer.from(JSON.stringify(allResults));
    }
  }
}

/**
 * Record spend made by an NGO
 * 
 * This functions allocates the spend amongst the donors, so each donor can see how their 
 * donations are spent. The logic works as follows:
 * 
 *    - Get the donations made to this NGO
 *    - Get the spend per donation, to calculate how much of the donation amount is still available for spending
 *    - Calculate the total amount spent by this NGO
 *    - If there are sufficient donations available, create a SPEND record
 *    - Allocate the spend between all the donations and create SPENDALLOCATION records
 * 
 * @param {*} spend - the spend amount to be recorded. This will be JSON, as follows:
 * {
 *   "docType": "spend",
 *   "spendId": "1234",
 *   "spendAmount": 100,
 *   "spendDate": "2018-09-20T12:41:59.582Z",
 *   "spendDescription": "Delias Dainty Delights",
 *   "ngoRegistrationNumber": "1234"
 * }
 */
async function allocateSpend(stub, spend) {
  console.log('============= START : allocateSpend ===========');
  console.log('##### allocateSpend - Spend received: ' + JSON.stringify(spend));

  // validate we have a valid SPEND object and a valid amount
  if (!(spend && spend['spendAmount'] && typeof spend['spendAmount'] === 'number' && isFinite(spend['spendAmount']))) {
    throw new Error('##### allocateSpend - Spend Amount is not a valid number: ' + spend['spendAmount']);   
  }
  // validate we have a valid SPEND object and a valid SPEND ID
  if (!(spend && spend['spendId'])) {
    throw new Error('##### allocateSpend - Spend Id is required but does not exist in the spend message');   
  }

  // validate that we have a valid NGO
  let ngo = spend['ngoRegistrationNumber'];
  let ngoKey = 'ngo' + ngo;
  let ngoQuery = await queryByKey(stub, ngoKey);
  if (!ngoQuery.toString()) {
    throw new Error('##### allocateSpend - Cannot create spend allocation record as the NGO does not exist: ' + json['ngoRegistrationNumber']);
  }

  // first, get the total amount of donations donated to this NGO
  let totalDonations = 0;
  const donationMap = new Map();
  let queryString = '{"selector": {"docType": "donation", "ngoRegistrationNumber": "' + ngo + '"}}';
  let donationsForNGO = await queryByString(stub, queryString);
  console.log('##### allocateSpend - allocateSpend - getDonationsForNGO: ' + donationsForNGO);
  donationsForNGO = JSON.parse(donationsForNGO.toString());
  console.log('##### allocateSpend - getDonationsForNGO as JSON: ' + donationsForNGO);

  // store all donations for the NGO in a map. Each entry in the map will look as follows:
  //
  // {"Key":"donation2211","Record":{"docType":"donation","donationAmount":100,"donationDate":"2018-09-20T12:41:59.582Z","donationId":"2211","donorUserName":"edge","ngoRegistrationNumber":"6322"}}
  for (let n = 0; n < donationsForNGO.length; n++) {
    let donation = donationsForNGO[n];
    console.log('##### allocateSpend - getDonationsForNGO Donation: ' + JSON.stringify(donation));
    totalDonations += donation['Record']['donationAmount'];
    // store the donations made
    donationMap.set(donation['Record']['donationId'], donation);
    console.log('##### allocateSpend - donationMap - adding new donation entry for donor: ' + donation['Record']['donationId'] + ', values: ' + JSON.stringify(donation));
  }
  console.log('##### allocateSpend - Total donations for this ngo are: ' + totalDonations);
  for (let donation of donationMap) {
    console.log('##### allocateSpend - Total donation for this donation ID: ' + donation[0] + ', amount: ' + donation[1]['Record']['donationAmount'] + ', entry: ' + JSON.stringify(donation[1]));
  }

  // next, get the spend by Donation, i.e. the amount of each Donation that has already been spent
  let totalSpend = 0;
  const donationSpendMap = new Map();
  queryString = '{"selector": {"docType": "spendAllocation", "ngoRegistrationNumber": "' + ngo + '"}}';
  let spendAllocations = await queryByString(stub, queryString);
  spendAllocations = JSON.parse(spendAllocations.toString());
  for (let n = 0; n < spendAllocations.length; n++) {
    let spendAllocation = spendAllocations[n]['Record'];
    totalSpend += spendAllocation['spendAllocationAmount'];
    // store the spend made per Donation
    if (donationSpendMap.has(spendAllocation['donationId'])) {
      let spendAmt = donationSpendMap.get(spendAllocation['donationId']);
      spendAmt += spendAllocation['spendAllocationAmount'];
      donationSpendMap.set(spendAllocation['donationId'], spendAmt);
      console.log('##### allocateSpend - donationSpendMap - updating donation entry for donation ID: ' + spendAllocation['donationId'] + ' amount: ' + spendAllocation['spendAllocationAmount'] + ' total amt: ' + spendAmt);
    }
    else {
      donationSpendMap.set(spendAllocation['donationId'], spendAllocation['spendAllocationAmount']);
      console.log('##### allocateSpend - donationSpendMap - adding new donation entry for donation ID: ' + spendAllocation['donationId'] + ' amount: ' + spendAllocation['spendAllocationAmount']);
    }
  }
  console.log('##### allocateSpend - Total spend for this ngo is: ' + totalSpend);
  for (let donation of donationSpendMap) {
    console.log('##### allocateSpend - Total spend against this donation ID: ' + donation[0] + ', spend amount: ' + donation[1] + ', entry: ' + donation);  
    if (donationMap.has(donation[0])) {
      console.log('##### allocateSpend - The matching donation for this donation ID: ' + donation[0] + ', donation amount: ' + donationMap.get(donation[0]));  
    }
    else {
      console.log('##### allocateSpend - ERROR - cannot find the matching donation for this spend record for donation ID: ' + donation[0]);  
    }
  }

  // at this point we have the total amount of donations made by donors to each NGO. We also have the total spend
  // spent by an NGO with a breakdown per donation. 

  // confirm whether the NGO has sufficient available funds to cover the new spend
  let totalAvailable = totalDonations - totalSpend;
  if (spend['spendAmount'] > totalAvailable) {
    // Execution stops at this point; the transaction fails and rolls back.
    // Any updates made by the transaction processor function are discarded.
    // Transaction processor functions are atomic; all changes are committed,
    // or no changes are committed.
    console.log('##### allocateSpend - NGO ' + ngo + ' does not have sufficient funds available to cover this spend. Spend amount is: ' + spend['spendAmount'] + '. Available funds are currently: ' + totalAvailable + '. Total donations are: ' + totalDonations + ', total spend is: ' + totalSpend);
    throw new Error('NGO ' + ngo + ' does not have sufficient funds available to cover this spend. Spend amount is: ' + spend['spendAmount'] + '. Available funds are currently: ' + totalAvailable);
  }

  // since the NGO has sufficient funds available, add the new spend record
  spend['docType'] = 'spend';
  let key = 'spend' + spend['spendId'];
  console.log('##### allocateSpend - Adding the spend record to NGOSpend. Spend record is: ' + JSON.stringify(spend) + ' key is: ' + key);
  await stub.putState(key, Buffer.from(JSON.stringify(spend)));

  // allocate the spend as equally as possible to all the donations
  console.log('##### allocateSpend - Allocating the spend amount amongst the donations from donors who donated funds to this NGO');
  let spendAmount = spend.spendAmount;
  let numberOfDonations = 0;
  let spendAmountForDonor = 0;
  let recordCounter = 0;

  while (true) {
    // spendAmount will be reduced as the spend is allocated to NGOSpendDonationAllocation records. 
    // Once it reaches 0 we stop allocating. This caters for cases where the full allocation cannot
    // be allocated to a donation record. In this case, only the remaining domation amount is allocated 
    // (see variable amountAllocatedToDonation below).
    // The remaining amount must be allocated to donation records with sufficient available funds.
    if (spendAmount <= 0) {
      break;
    }
    // calculate the number of donations still available, i.e. donations which still have funds available for spending. 
    // as the spending reduces the donations there may be fewer and fewer donations available to split the spending between
    // 
    // all donations for the NGO are in donationMap. Each entry in the map will look as follows:
    //
    // {"Key":"donation2211","Record":{"docType":"donation","donationAmount":100,"donationDate":"2018-09-20T12:41:59.582Z","donationId":"2211","donorUserName":"edge","ngoRegistrationNumber":"6322"}}
    numberOfDonations = 0;
    for (let donation of donationMap) {
      console.log('##### allocateSpend - Donation record, key is: ' +  donation[0] + ' value is: ' + JSON.stringify(donation[1]));
      if (donationSpendMap.has(donation[0])) {
        spendAmountForDonor = donationSpendMap.get(donation[0]);
      }
      else {
        spendAmountForDonor = 0;
      }
      let availableAmountForDonor = donation[1]['Record']['donationAmount'] - spendAmountForDonor;
      console.log('##### allocateSpend - Checking number of donations available for allocation. Donation ID: ' +  donation[0] + ' has spent: ' + spendAmountForDonor + ' and has the following amount available for spending: ' + availableAmountForDonor);
      if (availableAmountForDonor > 0) {
        numberOfDonations++;
      }
    }
    //Validate that we have a valid spendAmount, numberOfDonations and spendAmountForDonor
    //Invalid values could be caused by a bug in this function, or invalid values passed to this function
    //that were not caught by the validation process earlier.
    if (!(spendAmount && typeof spendAmount === 'number' && isFinite(spendAmount))) {
      throw new Error('##### allocateSpend - spendAmount is not a valid number: ' + spendAmount);   
    }
    if (!(numberOfDonations && typeof numberOfDonations === 'number' && numberOfDonations > 0)) {
      throw new Error('##### allocateSpend - numberOfDonations is not a valid number or is < 1: ' + numberOfDonations);   
    }
    //calculate how much spend to allocate to each donation
    let spendPerDonation = spendAmount / numberOfDonations;
    console.log('##### allocateSpend - Allocating the total spend amount of: ' + spendAmount + ', to ' + numberOfDonations + ' donations, resulting in ' + spendPerDonation + ' per donation');

    if (!(spendPerDonation && typeof spendPerDonation === 'number' && isFinite(spendPerDonation))) {
      throw new Error('##### allocateSpend - spendPerDonation is not a valid number: ' + spendPerDonation);   
    }

    // create the SPENDALLOCATION records. Each record looks as follows:
    //
    // {
    //   "docType":"spendAllocation",
    //   "spendAllocationId":"c5b39e938a29a80c225d10e8327caaf817f76aecd381c868263c4f59a45daf62-1",
    //   "spendAllocationAmount":38.5,
    //   "spendAllocationDate":"2018-09-20T12:41:59.582Z",
    //   "spendAllocationDescription":"Peter Pipers Poulty Portions for Pets",
    //   "donationId":"FFF6A68D-DB19-4CD3-97B0-01C1A793ED3B",
    //   "ngoRegistrationNumber":"D0884B20-385D-489E-A9FD-2B6DBE5FEA43",
    //   "spendId": "1234"
    // }

    for (let donation of donationMap) {
      let donationId = donation[0];
      let donationInfo = donation[1]['Record'];
      //calculate how much of the donation's amount remains available for spending
      let donationAmount = donationInfo['donationAmount'];
      if (donationSpendMap.has(donationId)) {
        spendAmountForDonor = donationSpendMap.get(donationId);
      }
      else {
        spendAmountForDonor = 0;
      }
      let availableAmountForDonor = donationAmount - spendAmountForDonor;
      //if the donation does not have sufficient funds to cover their allocation, then allocate
      //all of the outstanding donation funds
      let amountAllocatedToDonation = 0;
      if (availableAmountForDonor >= spendPerDonation) {
        amountAllocatedToDonation = spendPerDonation;
        console.log('##### allocateSpend - donation ID ' + donationId + ' has sufficient funds to cover full allocation. Allocating: ' + amountAllocatedToDonation);
      }
      else if (availableAmountForDonor > 0) {
        amountAllocatedToDonation = availableAmountForDonor;
        // reduce the number of donations available since this donation record is fully allocated
        numberOfDonations -= 1;
        console.log('##### allocateSpend - donation ID ' + donationId + ' does not have sufficient funds to cover full allocation. Using all available funds: ' + amountAllocatedToDonation);
      }
      else {
        // reduce the number of donations available since this donation record is fully allocated
        numberOfDonations -= 1;
        console.log('##### allocateSpend - donation ID ' + donationId + ' has no funds available at all. Available amount: ' + availableAmountForDonor + '. This donation ID will be ignored');
        continue;
      }
      // add a new spendAllocation record containing the portion of a donation allocated to this spend
      //
      // spendAllocationId is (hopefully) using an ID created in a deterministic manner, meaning it should
      // be identical on all endorsing peer nodes. If it isn't, the transaction validation process will fail
      // when Fabric compares the write-sets for each transaction and discovers there is are different values.
      let spendAllocationId = stub.getTxID() + '-' + recordCounter;
      recordCounter++;
      let key = 'spendAllocation' + spendAllocationId;
      let spendAllocationRecord = {
        docType: 'spendAllocation',
        spendAllocationId: spendAllocationId,
        spendAllocationAmount: amountAllocatedToDonation,
        spendAllocationDate: spend['spendDate'],
        spendAllocationDescription: spend['spendDescription'],
        donationId: donationId,
        ngoRegistrationNumber: ngo,
        spendId: spend['spendId']
      }; 

      console.log('##### allocateSpend - creating spendAllocationRecord record: ' + JSON.stringify(spendAllocationRecord));
      await stub.putState(key, Buffer.from(JSON.stringify(spendAllocationRecord)));

      //reduce the total spend amount by the amount just spent in the NGOSpendDonationAllocation record
      spendAmount -= amountAllocatedToDonation;

      //update the spending map entry for this NGO. There may be no existing spend, in which case we'll create an entry in the map
      if (donationSpendMap.has(donationId)) {
        let spendAmt = donationSpendMap.get(donationId);
        spendAmt += amountAllocatedToDonation;
        donationSpendMap.set(donationId, spendAmt);
        console.log('##### allocateSpend - donationSpendMap - updating spend entry for donation Id: ' + donationId + ' with spent amount allocated to donation: ' + amountAllocatedToDonation + ' - total amount of this donation now spent is: ' + spendAmt);
      }
      else {
        donationSpendMap.set(donationId, amountAllocatedToDonation);
        console.log('##### allocateSpend - donationSpendMap - adding new spend entry for donation ID: ' + donationId + ' with spent amount allocated to donation: ' + amountAllocatedToDonation);
      }
    }
  }
  console.log('============= END : allocateSpend ===========');
}  

/************************************************************************************************
 * 
 * CHAINCODE
 * 
 ************************************************************************************************/

let Chaincode = class {

  /**
   * Initialize the state when the chaincode is either instantiated or upgraded
   * 
   * @param {*} stub 
   */
  async Init(stub) {
    console.log('=========== Init: Instantiated / Upgraded ngo chaincode ===========');
    return shim.success();
  }

  /**
   * The Invoke method will call the methods below based on the method name passed by the calling
   * program.
   * 
   * @param {*} stub 
   */
  async Invoke(stub) {
    console.log('============= START : Invoke ===========');
    let ret = stub.getFunctionAndParameters();
    console.log('##### Invoke args: ' + JSON.stringify(ret));

    let method = this[ret.fcn];
    if (!method) {
      console.error('##### Invoke - error: no chaincode function with name: ' + ret.fcn + ' found');
      throw new Error('No chaincode function with name: ' + ret.fcn + ' found');
    }
    try {
      let response = await method(stub, ret.params);
      console.log('##### Invoke response payload: ' + response);
      return shim.success(response);
    } catch (err) {
      console.log('##### Invoke - error: ' + err);
      return shim.error(err);
    }
  }

  /**
   * Initialize the state. This should be explicitly called if required.
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async initLedger(stub, args) {
    console.log('============= START : Initialize Ledger ===========');
    console.log('============= END : Initialize Ledger ===========');
  }

  /************************************************************************************************
   * 
   * Donor functions 
   * 
   ************************************************************************************************/

   /**
   * Creates a new donor
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "donorUserName":"edge",
   *    "email":"edge@abc.com",
   *    "registeredDate":"2018-10-22T11:52:20.182Z"
   * }
   */
  async createDonor(stub, args) {
    console.log('============= START : createDonor ===========');
    console.log('##### createDonor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'donor' + json['donorUserName'];
    json['docType'] = 'donor';

    console.log('##### createDonor payload: ' + JSON.stringify(json));

    // Check if the donor already exists
    let donorQuery = await stub.getState(key);
    if (donorQuery.toString()) {
      throw new Error('##### createDonor - This donor already exists: ' + json['donorUserName']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createDonor ===========');
  }

  /**
   * Creates a Member
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
      "firstName" : "John",
      "middleName" : "M",
      "lastName": "Doe",
      "dob": "01/07/1993",
      "ssn": "123456789",
      "homePhoneNumber" : 1234567895
    }
   */
  async createMember(stub, args) {
    console.log('============= START : createMember ===========');
    console.log('##### createMember arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    //modifying key to accomodate multiple contracts here
    let key = 'member' + json['ssn']+':'+json['contractNumber'];
    json['docType'] = 'member';

    console.log('##### createMember payload: ' + JSON.stringify(json));

    // Check if the member already exists
    let donorQuery = await stub.getState(key);
    if (donorQuery.toString()) {
      throw new Error('##### createMember - This donor already exists: ' + json['ssn']);
    }
    //adding a create date field for easier sorting
    json.createDate = new Date();
    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createMember ===========');
  }

  /**
   * Retrieves a specfic donor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryDonor(stub, args) {
    console.log('============= START : queryDonor ===========');
    console.log('##### queryDonor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'donor' + json['donorUserName'];
    console.log('##### queryDonor key: ' + key);

    return queryByKey(stub, key);
  }

   /**
   * Retrieves a specfic member
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryMember(stub, args) {
    console.log('============= START : queryMember ===========');
    console.log('##### queryMember arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'member' + json['ssn'];
    console.log('##### queryMember key: ' + key);

    return queryByKey(stub, key);
  }

  /**
   * Retrieves all donors
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllDonors(stub, args) {
    console.log('============= START : queryAllDonors ===========');
    console.log('##### queryAllDonors arguments: ' + JSON.stringify(args));
 
    let queryString = '{"selector": {"docType": "donor"}}';
    return queryByString(stub, queryString);
  }

   /**
   * Retrieves all members
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllMembers(stub, args) {
    console.log('============= START : queryAllMembers ===========');
    console.log('##### queryAllMembers arguments: ' + JSON.stringify(args));
 
    let queryString = '{"selector": {"docType": "member"}}';
    return queryByString(stub, queryString);
  }


  /************************************************************************************************
   * 
   * NGO functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new NGO
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "ngoRegistrationNumber":"6322",
   *    "ngoName":"Pets In Need",
   *    "ngoDescription":"We help pets in need",
   *    "address":"1 Pet street",
   *    "contactNumber":"82372837",
   *    "contactEmail":"pets@petco.com"
   * }
   */
  async createNGO(stub, args) {
    console.log('============= START : createNGO ===========');
    console.log('##### createNGO arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'ngo' + json['ngoRegistrationNumber'];
    json['docType'] = 'ngo';

    console.log('##### createNGO payload: ' + JSON.stringify(json));

    // Check if the NGO already exists
    let ngoQuery = await stub.getState(key);
    if (ngoQuery.toString()) {
      throw new Error('##### createNGO - This NGO already exists: ' + json['ngoRegistrationNumber']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createNGO ===========');
  }

  async createEmployer(stub, args) {
    console.log('============= START : createEmployer ===========');
    console.log('##### createEmployer arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'employer' + json['contractNumber'];
    json['docType'] = 'employer';

    console.log('##### createEmployer payload: ' + JSON.stringify(json));

    // Check if the Employer already exists
    let ngoQuery = await stub.getState(key);
    if (ngoQuery.toString()) {
      throw new Error('##### createEmployer - This Employer already exists: ' + json['contractNumber']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createEmployer ===========');
  }

  async createPlan(stub, args) {
    console.log('============= START : createPlan ===========');
    console.log('##### createPlan arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'plan' + json['planId'];
    json['docType'] = 'plan';

    console.log('##### createPlan payload: ' + JSON.stringify(json));

    // Check if the NGO already exists
    let ngoQuery = await stub.getState(key);
    if (ngoQuery.toString()) {
      throw new Error('##### createPlan - This Plan already exists: ' + json['planId']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createPlan ===========');
  }

  /**
   * Retrieves a specfic ngo
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryNGO(stub, args) {
    console.log('============= START : queryNGO ===========');
    console.log('##### queryNGO arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'ngo' + json['ngoRegistrationNumber'];
    console.log('##### queryNGO key: ' + key);

    return queryByKey(stub, key);
  }

  async queryEmployer(stub, args) {
    console.log('============= START : queryEmployer ===========');
    console.log('##### queryEmployer arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'employer' + json['contractNumber'];
    console.log('##### queryEmployer key: ' + key);

    return queryByKey(stub, key);
  }

  async queryPlan(stub, args) {
    console.log('============= START : queryPlan ===========');
    console.log('##### queryPlan arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'plan' + json['planId'];
    console.log('##### queryPlan key: ' + key);

    return queryByKey(stub, key);
  }

  /**
   * Retrieves all ngos
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllNGOs(stub, args) {
    console.log('============= START : queryAllNGOs ===========');
    console.log('##### queryAllNGOs arguments: ' + JSON.stringify(args));
 
    let queryString = '{"selector": {"docType": "ngo"}}';
    return queryByString(stub, queryString);
  }

  async queryAllEmployers(stub, args) {
    console.log('============= START : queryAllEmployers ===========');
    console.log('##### queryAllEmployers arguments: ' + JSON.stringify(args));

    let queryString = '{"selector": {"docType": "employer"}}';
    return queryByString(stub, queryString);
  }

  async queryAllPlans(stub, args) {
    console.log('============= START : queryAllPlans ===========');
    console.log('##### queryAllPlans arguments: ' + JSON.stringify(args));

    let queryString = '{"selector": {"docType": "plan"}}';
    return queryByString(stub, queryString);
  }


  /************************************************************************************************
   * 
   * Donation functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Donation
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "donationId":"2211",
   *    "donationAmount":100,
   *    "donationDate":"2018-09-20T12:41:59.582Z",
   *    "donorUserName":"edge",
   *    "ngoRegistrationNumber":"6322"
   * }
   */
  async createDonation(stub, args) {
    console.log('============= START : createDonation ===========');
    console.log('##### createDonation arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'donation' + json['donationId'];
    json['docType'] = 'donation';

    console.log('##### createDonation donation: ' + JSON.stringify(json));

    // Confirm the NGO exists
    let ngoKey = 'ngo' + json['ngoRegistrationNumber'];
    let ngoQuery = await stub.getState(ngoKey);
    if (!ngoQuery.toString()) {
      throw new Error('##### createDonation - Cannot create donation as the NGO does not exist: ' + json['ngoRegistrationNumber']);
    }

    // Confirm the donor exists
    let donorKey = 'donor' + json['donorUserName'];
    let donorQuery = await stub.getState(donorKey);
    if (!donorQuery.toString()) {
      throw new Error('##### createDonation - Cannot create donation as the Donor does not exist: ' + json['donorUserName']);
    }

    // Check if the Donation already exists
    let donationQuery = await stub.getState(key);
    if (donationQuery.toString()) {
      throw new Error('##### createDonation - This Donation already exists: ' + json['donationId']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createDonation ===========');
  }

  //Create contribution EMPLOYER

  async createContributionEmployer(stub, args) {
    console.log('============= START : createContributionEmployer ===========');
    //console.log('##### createContributionEmployer arguments: ' + JSON.stringify(args));
    // args is passed as a JSON string
    let json = JSON.parse(args);

    let contractNumber = json['contractNumber'];
    let queryString = '{"selector": {"docType": "member", "contractNumber": "' + json['contractNumber'] + '"}}';
    let allMembersObj = await queryByString(stub, queryString);
    if (!allMembersObj.toString()) {
      throw new Error('##### No members exist for employer: ' + json['contractNumber']);
    }
    let allMembers = JSON.parse(allMembersObj.toString());
    let employerContribAmount = json['contributionAmount'];
    console.log('##### createContributionEmployer - Employer contribution amount is: ' + employerContribAmount);
    let grossAmount = 0;
    for (let n = 0; n < allMembers.length; n++) {
      if (grossAmount < employerContribAmount) {
        let member = allMembers[n]['Record'];
        console.log('##### createContributionEmployer - Processing for member :' + member['ssn']);
        let contribAndDeferral = member['contribAndDeferral'];
        let deferralPercent = contribAndDeferral['electiveDeferral'];
        console.log('##### createContributionEmployer - Elective Deferral for member is: ' + deferralPercent);
        let salary = member['salary'];
        console.log('##### createContributionEmployer - Salary for member is: ' + salary);
        let multiple = salary * deferralPercent;
        let amount = 0;
        if (multiple > 0) {
          amount = multiple/100;
        }
        console.log('##### createContributionEmployer - Amount for member is: ' + amount);
        grossAmount +=amount;

        if (grossAmount > employerContribAmount){
            throw new Error("Gross amount exceeds employer contrib amount.")
        }
        let totalNumberOfInvestments = member.investments.length;
        for (let j = 0; j < totalNumberOfInvestments; j++){
          member.investments[j].dollarVal = amount/totalNumberOfInvestments;
        }

        let memberContribution = {
          docType: 'contribution',
          ssn: member['ssn'],
          contractNumber: contractNumber,
          contributionDate: new Date(),
          investments: member.investments
        };
        console.log('##### createContributionEmployer -Final JSON before  createContribution call is: ' + memberContribution);
        //individual contribution method starts here

        console.log('============= START : createContribution ===========');
        console.log('##### createContribution arguments: ' + JSON.stringify(memberContribution));

        // args is passed as a JSON string
        let json1 = memberContribution;
        let today = new Date();
        let key = 'contribution'+':'+today.getHours()+':'+today.getMinutes();
        json1['docType'] = 'contribution';

        console.log('##### createContribution : ' + JSON.stringify(json1));

        // Confirm the Member exists
        let ngoKey = 'member' + json1['ssn']+':'+json1['contractNumber'];
        let ngoQuery = await stub.getState(ngoKey);
        if (!ngoQuery.toString()) {
          throw new Error('##### createContribution - Cannot create contribution as the Member does not exist: ' + json1['ssn']);
        }

        // Confirm the Employer exists
        let donorKey = 'employer' + json1['contractNumber'];
        let donorQuery = await stub.getState(donorKey);
        if (!donorQuery.toString()) {
          throw new Error('##### createContribution - Cannot create contribution as the Employer does not exist: ' + json1['contractNumber']);
        }

        // Check if the Contribution already exists
        let donationQuery = await stub.getState(key);
        if (donationQuery.toString()) {
          throw new Error('##### createContribution - This Contribution already exists: ' + json1['contributionKey']);
        }

        await stub.putState(key, Buffer.from(JSON.stringify(json1)));
        console.log('============= END : createContribution ===========');

      }else {
        throw new Error("Contribution fund exhausted, make sure you have enough balance before contribution for employer: "+json1["contractNumber"])
      }

    }


    console.log('============= END : createContribution ===========');
  }

  /**
   * Retrieves contributions by specific member
   *
   * @param {*} stub
   * @param {*} args
   */
  async queryContributionsByMember(stub, args) {
    console.log('============= START : queryContributionsByMember ===========');
    console.log('##### queryContributionsByMember arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "contribution", "ssn": "' + json['ssn'] + '"}}';
    return queryByString(stub, queryString);
  }

  async queryWithdrawalByMember(stub, args) {
    console.log('============= START : queryContributionsByMember ===========');
    console.log('##### queryContributionsByMember arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "withdrawal", "ssn": "' + json['ssn'] + '"}}';
    return queryByString(stub, queryString);
  }
  //Create withdrawal for  individual member

  async createWithdrawal(stub, args) {
    console.log('============= START : createWithdrawal ===========');
    console.log('##### createWithdrawal arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'withdrawal' + json['withdrawalKey'];
    json['docType'] = 'withdrawal';

    console.log('##### createWithdrawal : ' + JSON.stringify(json));

    // Confirm the Member exists
    let ngoKey = 'member' + json['ssn']+':'+json['contractNumber'];
    let ngoQuery = await stub.getState(ngoKey);
    if (!ngoQuery.toString()) {
      throw new Error('##### createWithdrawal - Cannot create withdrawal as the Member does not exist: ' + json['ssn']);
    }

    // Confirm the Employer exists
    let donorKey = 'employer' + json['contractNumber'];
    let donorQuery = await stub.getState(donorKey);
    if (!donorQuery.toString()) {
      throw new Error('##### createWithdrawal - Cannot create contribution as the Employer does not exist: ' + json['contractNumber']);
    }

    // Check if the Contribution already exists
    let donationQuery = await stub.getState(key);
    if (donationQuery.toString()) {
      throw new Error('##### createWithdrawal - This Contribution already exists: ' + json['withdrawalKey']);
   }
    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createWithdrawal ===========');
  }


  /**
   * Retrieves a specfic donation
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryDonation(stub, args) {
    console.log('============= START : queryDonation ===========');
    console.log('##### queryDonation arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'donation' + json['donationId'];
    console.log('##### queryDonation key: ' + key);
    return queryByKey(stub, key);
  }

  /**
   * Retrieves donations for a specfic donor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryDonationsForDonor(stub, args) {
    console.log('============= START : queryDonationsForDonor ===========');
    console.log('##### queryDonationsForDonor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "donation", "donorUserName": "' + json['donorUserName'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves donations for a specfic ngo
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryDonationsForNGO(stub, args) {
    console.log('============= START : queryDonationsForNGO ===========');
    console.log('##### queryDonationsForNGO arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "donation", "ngoRegistrationNumber": "' + json['ngoRegistrationNumber'] + '"}}';
    return queryByString(stub, queryString);
  }

    /**
     * Retrieves members for a specfic employer
     *
     * @param {*} stub
     * @param {*} args
     */
    async queryMembersForEmployer(stub, args) {
        console.log('============= START : queryMembersForEmployer ===========');
        console.log('##### queryMembersForEmployer arguments: ' + JSON.stringify(args));

        // args is passed as a JSON string
        let json = JSON.parse(args);
        let queryString = '{"selector": {"docType": "member", "contractNumber": "' + json['contractNumber'] + '"}}';
        return queryByString(stub, queryString);
    }

  async queryMembersBySsn(stub, args) {
    console.log('============= START : queryMembersForEmployer ===========');
    console.log('##### queryMembersForEmployer arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "member", "ssn": "' + json['ssn'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves all donations
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllDonations(stub, args) {
    console.log('============= START : queryAllDonations ===========');
    console.log('##### queryAllDonations arguments: ' + JSON.stringify(args)); 
    let queryString = '{"selector": {"docType": "donation"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * Spend functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Spend
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "ngoRegistrationNumber":"6322",
   *    "spendId":"2",
   *    "spendDescription":"Peter Pipers Poulty Portions for Pets",
   *    "spendDate":"2018-09-20T12:41:59.582Z",
   *    "spendAmount":33,
   * }
   */
  async createSpend(stub, args) {
    console.log('============= START : createSpend ===========');
    console.log('##### createSpend arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'spend' + json['spendId'];
    json['docType'] = 'spend';

    console.log('##### createSpend spend: ' + JSON.stringify(json));

    // Confirm the NGO exists
    let ngoKey = 'ngo' + json['ngoRegistrationNumber'];
    let ngoQuery = await stub.getState(ngoKey);
    if (!ngoQuery.toString()) {
      throw new Error('##### createDonation - Cannot create spend record as the NGO does not exist: ' + json['ngoRegistrationNumber']);
    }

    // Check if the Spend already exists
    let spendQuery = await stub.getState(key);
    if (spendQuery.toString()) {
      throw new Error('##### createSpend - This Spend already exists: ' + json['spendId']);
    }

    await allocateSpend(stub, json);

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createSpend ===========');
  }

  /**
   * Retrieves a specfic spend
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpend(stub, args) {
    console.log('============= START : querySpend ===========');
    console.log('##### querySpend arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'spend' + json['spendId'];
    console.log('##### querySpend key: ' + key);
    return queryByKey(stub, key);
  }

  /**
   * Retrieves spend for a specfic ngo
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendForNGO(stub, args) {
    console.log('============= START : querySpendForNGO ===========');
    console.log('##### querySpendForNGO arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "spend", "ngoRegistrationNumber": "' + json['ngoRegistrationNumber'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves all spend
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllSpend(stub, args) {
    console.log('============= START : queryAllSpends ===========');
    console.log('##### queryAllSpends arguments: ' + JSON.stringify(args)); 
    let queryString = '{"selector": {"docType": "spend"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * SpendAllocation functions 
   * 
   ************************************************************************************************/

  /**
   * There is no CREATE SpendAllocation - the allocations are created in the function: allocateSpend
   * 
   * SPENDALLOCATION records look as follows:
   *
   * {
   *   "docType":"spendAllocation",
   *   "spendAllocationId":"c5b39e938a29a80c225d10e8327caaf817f76aecd381c868263c4f59a45daf62-1",
   *   "spendAllocationAmount":38.5,
   *   "spendAllocationDate":"2018-09-20T12:41:59.582Z",
   *   "spendAllocationDescription":"Peter Pipers Poulty Portions for Pets",
   *   "donationId":"FFF6A68D-DB19-4CD3-97B0-01C1A793ED3B",
   *   "ngoRegistrationNumber":"D0884B20-385D-489E-A9FD-2B6DBE5FEA43",
   *   "spendId": "1234"
   * }
   */

  /**
   * Retrieves a specfic spendAllocation
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendAllocation(stub, args) {
    console.log('============= START : querySpendAllocation ===========');
    console.log('##### querySpendAllocation arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'spendAllocation' + json['spendAllocationId'];
    console.log('##### querySpendAllocation key: ' + key);
    return queryByKey(stub, key);
  }

  /**
   * Retrieves the spendAllocation records for a specific Donation
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendAllocationForDonation(stub, args) {
    console.log('============= START : querySpendAllocationForDonation ===========');
    console.log('##### querySpendAllocationForDonation arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "spendAllocation", "donationId": "' + json['donationId'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves the spendAllocation records for a specific Spend record
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendAllocationForSpend(stub, args) {
    console.log('============= START : querySpendAllocationForSpend ===========');
    console.log('##### querySpendAllocationForSpend arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "spendAllocation", "spendId": "' + json['spendId'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves all spendAllocations
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllSpendAllocations(stub, args) {
    console.log('============= START : queryAllSpendAllocations ===========');
    console.log('##### queryAllSpendAllocations arguments: ' + JSON.stringify(args)); 
    let queryString = '{"selector": {"docType": "spendAllocation"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * Ratings functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Rating
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "ngoRegistrationNumber":"6322",
   *    "donorUserName":"edge",
   *    "rating":1,
   * }
   */
  async createRating(stub, args) {
    console.log('============= START : createRating ===========');
    console.log('##### createRating arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'rating' + json['ngoRegistrationNumber'] + json['donorUserName'];
    json['docType'] = 'rating';

    console.log('##### createRating payload: ' + JSON.stringify(json));

    // Check if the Rating already exists
    let ratingQuery = await stub.getState(key);
    if (ratingQuery.toString()) {
      throw new Error('##### createRating - Rating by donor: ' +  json['donorUserName'] + ' for NGO: ' + json['ngoRegistrationNumber'] + ' already exists');
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createRating ===========');
  }

  /**
   * Retrieves ratings for a specfic ngo
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryRatingsForNGO(stub, args) {
    console.log('============= START : queryRatingsForNGO ===========');
    console.log('##### queryRatingsForNGO arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "rating", "ngoRegistrationNumber": "' + json['ngoRegistrationNumber'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves ratings for an ngo made by a specific donor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryDonorRatingsForNGO(stub, args) {
    console.log('============= START : queryDonorRatingsForNGO ===========');
    console.log('##### queryDonorRatingsForNGO arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'rating' + json['ngoRegistrationNumber'] + json['donorUserName'];
    console.log('##### queryDonorRatingsForNGO key: ' + key);
    return queryByKey(stub, key);
  }

  /************************************************************************************************
   * 
   * Blockchain related functions 
   * 
   ************************************************************************************************/

  /**
   * Retrieves the Fabric block and transaction details for a key or an array of keys
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * [
   *    {"key": "a207aa1e124cc7cb350e9261018a9bd05fb4e0f7dcac5839bdcd0266af7e531d-1"}
   * ]
   * 
   */
  async queryHistoryForKey(stub, args) {
    console.log('============= START : queryHistoryForKey ===========');
    console.log('##### queryHistoryForKey arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = json['key'];
    let docType = json['docType']
    console.log('##### queryHistoryForKey key: ' + key);
    let historyIterator = await stub.getHistoryForKey(docType + key);
    console.log('##### queryHistoryForKey historyIterator: ' + util.inspect(historyIterator));
    let history = [];
    while (true) {
      let historyRecord = await historyIterator.next();
      console.log('##### queryHistoryForKey historyRecord: ' + util.inspect(historyRecord));
      if (historyRecord.value && historyRecord.value.value.toString()) {
        let jsonRes = {};
        console.log('##### queryHistoryForKey historyRecord.value.value: ' + historyRecord.value.value.toString('utf8'));
        jsonRes.TxId = historyRecord.value.tx_id;
        jsonRes.Timestamp = historyRecord.value.timestamp;
        jsonRes.IsDelete = historyRecord.value.is_delete.toString();
      try {
          jsonRes.Record = JSON.parse(historyRecord.value.value.toString('utf8'));
        } catch (err) {
          console.log('##### queryHistoryForKey error: ' + err);
          jsonRes.Record = historyRecord.value.value.toString('utf8');
        }
        console.log('##### queryHistoryForKey json: ' + util.inspect(jsonRes));
        history.push(jsonRes);
      }
      if (historyRecord.done) {
        await historyIterator.close();
        console.log('##### queryHistoryForKey all results: ' + JSON.stringify(history));
        console.log('============= END : queryHistoryForKey ===========');
        return Buffer.from(JSON.stringify(history));
      }
    }
  }
}
shim.start(new Chaincode());
