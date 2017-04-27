#!/usr/bin/env node

const rs = require('../util/request-scheduler');
const logger = require('../util/logger');
const config = require('../util/config');
const ConcurrencyPool = require('../util/concurrency-pool');
const ApiError = require('../util/api-error');

logger.setLevel(config.logLevel);
const pool = new ConcurrencyPool(config.concurrencyLimit);

async function deleteCustomSchema() {
  logger.header('Deleting custom schema');
  const schema = await rs.get('/api/v1/meta/schemas/user/default');
  const props = Object.keys(schema.definitions.custom.properties);
  if (props.length === 0) {
    logger.info('No custom properties to delete');
    return;
  }
  logger.info(`Deleting ${props.length} custom properties`);
  const options = {
    url: '/api/v1/meta/schemas/user/default',
    body: {
      definitions: {
        custom: {
          id: '#custom',
          type: 'object',
          properties: {}
        }
      }
    }
  };
  for (let prop of props) {
    options.body.definitions.custom.properties[prop] = null;
  }
  try {
    await rs.post(options);
    logger.info(`Deleted ${props.length} custom properties`);
  } catch (err) {
    logger.error(new ApiError(`Error deleting custom properties`, err));
  }
}

async function deleteGroups() {
  logger.header('Deleting groups');
  const groups = await rs.get('/api/v1/groups');
  logger.info(`Found ${groups.length} groups`);
  return pool.each(groups, async (group) => {
    if (group.type === 'BUILT_IN') {
      logger.info(`Skipping group id=${group.id} name=${group.profile.name}`);
      return;
    }
    try {
      await rs.delete(`/api/v1/groups/${group.id}`);
      logger.info(`Deleted group id=${group.id} name=${group.profile.name}`);
    } catch (err) {
      logger.error(new ApiError(`Error deleting group id=${group.id} name=${group.profile.name}`, err));
    }
  });
}

async function deleteUsers() {
  logger.header(`Deleting users`);
  while(true) {
    const users = await rs.get(`/api/v1/users`);
    logger.info(`Found ${users.length} users`);
    const res = await pool.each(users, async (user) => {
      try {
        await rs.post(`/api/v1/users/${user.id}/lifecycle/deactivate`);
        await rs.delete(`/api/v1/users/${user.id}`);
        logger.info(`Deleted user id=${user.id} login=${user.profile.login}`);
      } catch (err) {
        logger.error(new ApiError(`Error deleting user id=${user.id} login=${user.profile.login}`, err));
      }
    });
    // Default (and max) limit for number of users returned is 200. If we have
    // less than 200, it means we've got the last set.
    if (users.length < 200) {
      break;
    }
  }
}

async function deleteDeprovisionedUsers() {
  logger.header('Deleting deprovisioned users');
  const filter = encodeURIComponent('status eq "DEPROVISIONED"');
  while (true) {
    const users = await rs.get(`/api/v1/users?filter=${filter}`);
    logger.info(`Found ${users.length} deprovisioned users`);
    const res = await pool.each(users, async (user) => {
      try {
        await rs.delete(`/api/v1/users/${user.id}`);
        logger.info(`Deleted user id=${user.id} login=${user.profile.login}`);
      } catch (err) {
        logger.error(new ApiError(`Error deleting user id=${user.id} login=${user.profile.login}`, err));
      }
    });
    if (users.length < 200) {
      break;
    }
  }
}

async function deleteClients() {
  logger.header('Deleting OAuth Clients');
  const clients = await rs.get('/oauth2/v1/clients');
  logger.info(`Found ${clients.length} clients`);
  return pool.each(clients, async (client) => {
    try {
      await rs.delete(`/oauth2/v1/clients/${client.client_id}`);
      logger.info(`Deleted client id=${client.client_id} name=${client.client_name}`);
    } catch (err) {
      logger.error(new ApiError(`Error deleting OAuth client id=${client.client_id} name=${client.client_name}`, err));
    }
  });
}

async function deleteAuthorizationServers() {
  logger.header('Deleting authorization servers');
  const servers = await rs.get('/api/v1/as');
  logger.info(`Found ${servers.length} authorization servers`);
  return pool.each(servers, async (as) => {
    try {
      await rs.delete(`/api/v1/as/${as.id}`);
      logger.info(`Deleted authorization server id=${as.id} name=${as.name}`);
    } catch (err) {
      logger.error(new ApiError(`Error deleting authorization server id=${as.id} name=${as.name}`, err));
    }
  });
}

async function deletePasswordPolicies() {
  logger.header('Deleting password policies');
  const policies = await rs.get('/api/v1/policies?type=PASSWORD');
  logger.info(`Found ${policies.length} password policies`);
  // Note: Get 500's when deleting multiple password policies concurrently
  const policyPool = new ConcurrencyPool(1);
  return policyPool.each(policies, async (policy) => {
    if (policy.system) {
      logger.info(`Skipping password policy id=${policy.id} name=${policy.name}`);
      return;
    }
    try {
      await rs.delete(`/api/v1/policies/${policy.id}`);
      logger.info(`Deleted password policy id=${policy.id} name=${policy.name}`);
    } catch (err) {
      logger.error(new ApiError(`Error deleting password policy id=${policy.id} name=${policy.name}`, err));
    }
  });
}

async function deleteIdps() {
  logger.header('Deleting IDPs');
  const idps = await rs.get('/api/v1/idps');
  logger.info(`Found ${idps.length} IDPs`);
  return pool.each(idps, async (idp) => {
    try {
      await rs.delete(`/api/v1/idps/${idp.id}`);
      logger.info(`Deleted IDP id=${idp.id} name=${idp.name} type=${idp.type}`);
    } catch (err) {
      logger.error(new ApiError(`Error deleting IDP id=${idp.id} name=${idp.name}`, err));
    }
  });
}

async function deleteIdpKeys() {
  logger.header('Deleting IDP cert keys');
  const keys = await rs.get('/api/v1/idps/credentials/keys');
  logger.info(`Found ${keys.length} keys`);
  return pool.each(keys, async (key) => {
    try {
      await rs.delete(`/api/v1/idps/credentials/keys/${key.kid}`);
      logger.info(`Deleted IDP cert key kid=${key.kid}`);
    } catch (err) {
      logger.error(new ApiError(`Error deleting IDP cert key kid=${key.kid}`, err));
    }
  });
}

async function reset() {
  console.time('reset');
  try {
    await deleteCustomSchema();
    await deleteGroups();
    await deleteUsers();
    await deleteDeprovisionedUsers();
    await deleteClients();
    await deleteAuthorizationServers();
    await deletePasswordPolicies();
    await deleteIdps();
    await deleteIdpKeys();
  } catch (err) {
    logger.error(err);
  }
  logger.header('Done');
  console.timeEnd('reset');
}

reset();
