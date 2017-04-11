const fs = require('fs');
const Base = require('./base');
const logger = require('../util/logger');
const config = require('../util/config');
const cache = require('../migrators/util/cache');

/**
 * Flattens custom data object, i.e:
 *   {
 *     address: {
 *       number: 5
 *       street: 'Brannan St.'
 *     }
 *   }
 * Becomes:
 *   {
 *     address_number: 5,
 *     address_street: 'Brannan St'
 *   }
 */
function flattenCustomData(customData, prefix = '') {
  const keys = Object.keys(customData);
  const prefixStr = prefix === '' ? '' : `${prefix}_`;
  const flattened = {};
  for (let key of keys) {
    const val = customData[key];
    if (!!val && !Array.isArray(val) && typeof val === 'object') {
      const nested = flattenCustomData(val, `${prefixStr}${key}`);
      Object.assign(flattened, nested);
    }
    else {
      flattened[`${prefixStr}${key}`] = val;
    }
  }
  return flattened;
}

/**
 * Transforms custom data value to an object with:
 *   type: array-number, array-string, boolean, number, string
 *   val: coerced value
 * If the type is an object, stringifies the object and stores as a string.
 * @param {*} val custom data value
 * @return {Object} type, val
 */
function transform(original) {
  let type;
  let val;

  if (Array.isArray(original)) {
    // There are three array types - string, number, and integer. If the array
    // is empty, or its first value is anything other than a number, use
    // the string array.
    type = original.length > 0 && typeof original[0] === 'number'
      ? 'array-number'
      : 'array-string';
    val = original.map((item) => {
      return type === 'array-string' ? JSON.stringify(item) : item;
    });
  }
  else if (typeof original === 'boolean') {
    type = 'boolean';
    val = original;
  }
  else if (typeof original === 'number') {
    type = 'number';
    val = original;
  }
  else if (typeof original === 'string') {
    type = 'string';
    val = original;
  }
  else {
    type = 'string';
    val = JSON.stringify(original);
  }

  return { type, val };
}

/**
 * Sets default 'not_provided' value for required attributes
 * @param {Object} profileAttributes
 */
function addRequiredAttributes(profile) {
  const missing = [];
  ['firstName', 'lastName'].forEach((attr) => {
    if (!profile[attr]) {
      profile[attr] = 'not_provided';
      missing.push(attr);
    }
  });
  if (missing.length > 0) {
    const attrs = missing.join(',');
    logger.warn(`Setting required attributes ${attrs} to 'not_provided' for email=${profile.email}`);
  }
  return profile;
}

class Account extends Base {

  constructor(filePath, json, options) {
    super(filePath, json);
    this.apiKeys = options.accountApiKeys[this.id] || [];
    this.accountIds = [this.id];
    this.directoryIds = [this.directory.id];
    this.externalIds = {};
    if (this.externalId) {
      this.externalIds[this.directory.id] = this.externalId;
    }
  }

  /**
   * Merges properties from another account into this account.
   * @param {Account} account
   */
  merge(account) {
    // 1. Base stormpath properties - only overrides properties that aren't already set
    const mergeableProperties = [
      'username',
      'givenName',
      'middleName',
      'surName',
      'fullName'
    ];
    mergeableProperties.forEach((prop) => {
      if (!this[prop]) {
        this[prop] = account[prop];
      }
    });

    // 2. Custom data properties - only overrides properties that aren't already set
    Object.keys(account.customData).forEach((key) => {
      if (!this.customData[key]) {
        this.customData[key] = account.customData[key];
      }
    });

    // 3. ApiKeys - merges both apiKeys together
    this.apiKeys = this.apiKeys.concat(account.apiKeys);

    // 4. Keep a record of which accounts have been merged
    this.accountIds.push(account.id);
    this.directoryIds.push(account.directory.id);

    // 5. Add directoryId -> externalId mapping if there is an externalId
    if (account.externalId) {
      this.externalIds[account.directory.id] = account.externalId;
    }
  }

  getProfileAttributes() {
    // Note: firstName and lastName are required attributes. If these are not
    // available, default to "not_provided"
    const profileAttributes = addRequiredAttributes({
      login: this.username,
      email: this.email,
      firstName: this.givenName,
      middleName: this.middleName,
      lastName: this.surname,
      displayName: this.fullName
    });

    const customData = this.getCustomData();
    const invalid = [];
    Object.keys(customData).forEach((key) => {
      const property = customData[key];
      const schemaType = cache.customSchemaTypeMap[key];
      if (property.type !== schemaType) {
        invalid.push({ property: key, type: property.type, expected: schemaType });
      }
      else {
        profileAttributes[key] = customData[key].val;
      }
    });

    if (invalid.length > 0) {
      logger.warn(`Account ids=${this.accountIds} contain customData that does not match the expected schema types - removing`, invalid);
    }

    return profileAttributes;
  }

  getCustomData() {
    const customData = {};

    if (config.isCustomDataStringify) {
      customData['customData'] = transform(JSON.stringify(this.customData));
    }
    else if (config.isCustomDataSchema) {
      const skip = ['createdAt', 'modifiedAt', 'href', 'id'];
      const flattened = flattenCustomData(this.customData);
      const keys = Object.keys(flattened).filter(key => !skip.includes(key));
      for (let key of keys) {
        // We store apiKeys/secrets under the stormpathApiKey_ namespace, throw
        // an error if they try to create a custom property with this key
        if (key.indexOf('stormpathApiKey_') === 0) {
          throw new Error(`${key} is a reserved property name`);
        }
        customData[key] = transform(this.customData[key]);
      }
    }

    // Add apiKeys to custom data with the special keys stormpathApiKey_*
    this.apiKeys.forEach((key, i) => {
      if (i < 10) {
        customData[`stormpathApiKey_${i+1}`] = transform(`${key.id}:${key.secret}`);
      }
    });
    const numApiKeys = this.apiKeys.length;
    if (numApiKeys > 10) {
      logger.warn(`Account id=${this.id} has ${numApiKeys} apiKeys, but max is 10. Dropping ${numApiKeys - 10} keys.`);
    }

    return customData;
  }

  setOktaUserId(oktaUserId) {
    this.oktaUserId = oktaUserId;
  }

  getOktaUserId() {
    return this.oktaUserId;
  }

  getExternalIdForDirectory(directoryId) {
    return this.externalIds[directoryId];
  }

}

module.exports = Account;
