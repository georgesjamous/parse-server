"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ParseLiveQueryServer = void 0;

var _tv = _interopRequireDefault(require("tv4"));

var _node = _interopRequireDefault(require("parse/node"));

var _Subscription = require("./Subscription");

var _Client = require("./Client");

var _ParseWebSocketServer = require("./ParseWebSocketServer");

var _logger = _interopRequireDefault(require("../logger"));

var _RequestSchema = _interopRequireDefault(require("./RequestSchema"));

var _QueryTools = require("./QueryTools");

var _ParsePubSub = require("./ParsePubSub");

var _SchemaController = _interopRequireDefault(require("../Controllers/SchemaController"));

var _lodash = _interopRequireDefault(require("lodash"));

var _uuid = _interopRequireDefault(require("uuid"));

var _triggers = require("../triggers");

var _Auth = require("../Auth");

var _Controllers = require("../Controllers");

var _lruCache = _interopRequireDefault(require("lru-cache"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class ParseLiveQueryServer {
  // className -> (queryHash -> subscription)
  // The subscriber we use to get object update from publisher
  constructor(server, config = {}) {
    this.server = server;
    this.clients = new Map();
    this.subscriptions = new Map();
    config.appId = config.appId || _node.default.applicationId;
    config.masterKey = config.masterKey || _node.default.masterKey; // Store keys, convert obj to map

    const keyPairs = config.keyPairs || {};
    this.keyPairs = new Map();

    for (const key of Object.keys(keyPairs)) {
      this.keyPairs.set(key, keyPairs[key]);
    }

    _logger.default.verbose('Support key pairs', this.keyPairs); // Initialize Parse


    _node.default.Object.disableSingleInstance();

    const serverURL = config.serverURL || _node.default.serverURL;
    _node.default.serverURL = serverURL;

    _node.default.initialize(config.appId, _node.default.javaScriptKey, config.masterKey); // The cache controller is a proper cache controller
    // with access to User and Roles


    this.cacheController = (0, _Controllers.getCacheController)(config); // This auth cache stores the promises for each auth resolution.
    // The main benefit is to be able to reuse the same user / session token resolution.

    this.authCache = new _lruCache.default({
      max: 500,
      // 500 concurrent
      maxAge: 60 * 60 * 1000 // 1h

    }); // Initialize websocket server

    this.parseWebSocketServer = new _ParseWebSocketServer.ParseWebSocketServer(server, parseWebsocket => this._onConnect(parseWebsocket), config.websocketTimeout); // Initialize subscriber

    this.subscriber = _ParsePubSub.ParsePubSub.createSubscriber(config);
    this.subscriber.subscribe(_node.default.applicationId + 'afterSave');
    this.subscriber.subscribe(_node.default.applicationId + 'afterDelete'); // Register message handler for subscriber. When publisher get messages, it will publish message
    // to the subscribers and the handler will be called.

    this.subscriber.on('message', (channel, messageStr) => {
      _logger.default.verbose('Subscribe messsage %j', messageStr);

      let message;

      try {
        message = JSON.parse(messageStr);
      } catch (e) {
        _logger.default.error('unable to parse message', messageStr, e);

        return;
      }

      this._inflateParseObject(message);

      if (channel === _node.default.applicationId + 'afterSave') {
        this._onAfterSave(message);
      } else if (channel === _node.default.applicationId + 'afterDelete') {
        this._onAfterDelete(message);
      } else {
        _logger.default.error('Get message %s from unknown channel %j', message, channel);
      }
    });
  } // Message is the JSON object from publisher. Message.currentParseObject is the ParseObject JSON after changes.
  // Message.originalParseObject is the original ParseObject JSON.


  _inflateParseObject(message) {
    // Inflate merged object
    const currentParseObject = message.currentParseObject;
    let className = currentParseObject.className;
    let parseObject = new _node.default.Object(className);

    parseObject._finishFetch(currentParseObject);

    message.currentParseObject = parseObject; // Inflate original object

    const originalParseObject = message.originalParseObject;

    if (originalParseObject) {
      className = originalParseObject.className;
      parseObject = new _node.default.Object(className);

      parseObject._finishFetch(originalParseObject);

      message.originalParseObject = parseObject;
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterDelete(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterDelete is triggered');

    const deletedParseObject = message.currentParseObject.toJSON();
    const classLevelPermissions = message.classLevelPermissions;
    const className = deletedParseObject.className;

    _logger.default.verbose('ClassName: %j | ObjectId: %s', className, deletedParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isSubscriptionMatched = this._matchesSubscription(deletedParseObject, subscription);

      if (!isSubscriptionMatched) {
        continue;
      }

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          const acl = message.currentParseObject.getACL(); // Check CLP

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            // Check ACL
            return this._matchesACL(acl, client, requestId);
          }).then(isMatched => {
            if (!isMatched) {
              return null;
            }

            client.pushDelete(requestId, deletedParseObject);
          }).catch(error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterSave(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterSave is triggered');

    let originalParseObject = null;

    if (message.originalParseObject) {
      originalParseObject = message.originalParseObject.toJSON();
    }

    const classLevelPermissions = message.classLevelPermissions;
    const currentParseObject = message.currentParseObject.toJSON();
    const className = currentParseObject.className;

    _logger.default.verbose('ClassName: %s | ObjectId: %s', className, currentParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isOriginalSubscriptionMatched = this._matchesSubscription(originalParseObject, subscription);

      const isCurrentSubscriptionMatched = this._matchesSubscription(currentParseObject, subscription);

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          // Set orignal ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL
          let originalACLCheckingPromise;

          if (!isOriginalSubscriptionMatched) {
            originalACLCheckingPromise = Promise.resolve(false);
          } else {
            let originalACL;

            if (message.originalParseObject) {
              originalACL = message.originalParseObject.getACL();
            }

            originalACLCheckingPromise = this._matchesACL(originalACL, client, requestId);
          } // Set current ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL


          let currentACLCheckingPromise;

          if (!isCurrentSubscriptionMatched) {
            currentACLCheckingPromise = Promise.resolve(false);
          } else {
            const currentACL = message.currentParseObject.getACL();
            currentACLCheckingPromise = this._matchesACL(currentACL, client, requestId);
          }

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            return Promise.all([originalACLCheckingPromise, currentACLCheckingPromise]);
          }).then(([isOriginalMatched, isCurrentMatched]) => {
            _logger.default.verbose('Original %j | Current %j | Match: %s, %s, %s, %s | Query: %s', originalParseObject, currentParseObject, isOriginalSubscriptionMatched, isCurrentSubscriptionMatched, isOriginalMatched, isCurrentMatched, subscription.hash); // Decide event type


            let type;

            if (isOriginalMatched && isCurrentMatched) {
              type = 'Update';
            } else if (isOriginalMatched && !isCurrentMatched) {
              type = 'Leave';
            } else if (!isOriginalMatched && isCurrentMatched) {
              if (originalParseObject) {
                type = 'Enter';
              } else {
                type = 'Create';
              }
            } else {
              return null;
            }

            const functionName = 'push' + type;
            client[functionName](requestId, currentParseObject);
          }, error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  }

  _onConnect(parseWebsocket) {
    parseWebsocket.on('message', request => {
      if (typeof request === 'string') {
        try {
          request = JSON.parse(request);
        } catch (e) {
          _logger.default.error('unable to parse request', request, e);

          return;
        }
      }

      _logger.default.verbose('Request: %j', request); // Check whether this request is a valid request, return error directly if not


      if (!_tv.default.validate(request, _RequestSchema.default['general']) || !_tv.default.validate(request, _RequestSchema.default[request.op])) {
        _Client.Client.pushError(parseWebsocket, 1, _tv.default.error.message);

        _logger.default.error('Connect message error %s', _tv.default.error.message);

        return;
      }

      switch (request.op) {
        case 'connect':
          this._handleConnect(parseWebsocket, request);

          break;

        case 'subscribe':
          this._handleSubscribe(parseWebsocket, request);

          break;

        case 'update':
          this._handleUpdateSubscription(parseWebsocket, request);

          break;

        case 'unsubscribe':
          this._handleUnsubscribe(parseWebsocket, request);

          break;

        default:
          _Client.Client.pushError(parseWebsocket, 3, 'Get unknown operation');

          _logger.default.error('Get unknown operation', request.op);

      }
    });
    parseWebsocket.on('disconnect', () => {
      _logger.default.info(`Client disconnect: ${parseWebsocket.clientId}`);

      const clientId = parseWebsocket.clientId;

      if (!this.clients.has(clientId)) {
        (0, _triggers.runLiveQueryEventHandlers)({
          event: 'ws_disconnect_error',
          clients: this.clients.size,
          subscriptions: this.subscriptions.size,
          error: `Unable to find client ${clientId}`
        });

        _logger.default.error(`Can not find client ${clientId} on disconnect`);

        return;
      } // Delete client


      const client = this.clients.get(clientId);
      this.clients.delete(clientId); // Delete client from subscriptions

      for (const [requestId, subscriptionInfo] of _lodash.default.entries(client.subscriptionInfos)) {
        const subscription = subscriptionInfo.subscription;
        subscription.deleteClientSubscription(clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

        const classSubscriptions = this.subscriptions.get(subscription.className);

        if (!subscription.hasSubscribingClient()) {
          classSubscriptions.delete(subscription.hash);
        } // If there is no subscriptions under this class, remove it from subscriptions


        if (classSubscriptions.size === 0) {
          this.subscriptions.delete(subscription.className);
        }
      }

      _logger.default.verbose('Current clients %d', this.clients.size);

      _logger.default.verbose('Current subscriptions %d', this.subscriptions.size);

      (0, _triggers.runLiveQueryEventHandlers)({
        event: 'ws_disconnect',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size
      });
    });
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'ws_connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _matchesSubscription(parseObject, subscription) {
    // Object is undefined or null, not match
    if (!parseObject) {
      return false;
    }

    return (0, _QueryTools.matchesQuery)(parseObject, subscription.query);
  }

  getAuthForSessionToken(sessionToken) {
    if (!sessionToken) {
      return Promise.resolve({});
    }

    const fromCache = this.authCache.get(sessionToken);

    if (fromCache) {
      return fromCache;
    }

    const authPromise = (0, _Auth.getAuthForSessionToken)({
      cacheController: this.cacheController,
      sessionToken: sessionToken
    }).then(auth => {
      return {
        auth,
        userId: auth && auth.user && auth.user.id
      };
    }).catch(error => {
      // There was an error with the session token
      const result = {};

      if (error && error.code === _node.default.Error.INVALID_SESSION_TOKEN) {
        // Store a resolved promise with the error for 10 minutes
        result.error = error;
        this.authCache.set(sessionToken, Promise.resolve(result), 60 * 10 * 1000);
      } else {
        this.authCache.del(sessionToken);
      }

      return result;
    });
    this.authCache.set(sessionToken, authPromise);
    return authPromise;
  }

  async _matchesCLP(classLevelPermissions, object, client, requestId, op) {
    // try to match on user first, less expensive than with roles
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let userId;

    if (typeof subscriptionInfo !== 'undefined') {
      const {
        userId
      } = await this.getAuthForSessionToken(subscriptionInfo.sessionToken);

      if (userId) {
        aclGroup.push(userId);
      }
    }

    try {
      await _SchemaController.default.validatePermission(classLevelPermissions, object.className, aclGroup, op);
      return true;
    } catch (e) {
      _logger.default.verbose(`Failed matching CLP for ${object.id} ${userId} ${e}`);

      return false;
    } // TODO: handle roles permissions
    // Object.keys(classLevelPermissions).forEach((key) => {
    //   const perm = classLevelPermissions[key];
    //   Object.keys(perm).forEach((key) => {
    //     if (key.indexOf('role'))
    //   });
    // })
    // // it's rejected here, check the roles
    // var rolesQuery = new Parse.Query(Parse.Role);
    // rolesQuery.equalTo("users", user);
    // return rolesQuery.find({useMasterKey:true});

  }

  _getCLPOperation(query) {
    return typeof query === 'object' && Object.keys(query).length == 1 && typeof query.objectId === 'string' ? 'get' : 'find';
  }

  async _verifyACL(acl, token) {
    if (!token) {
      return false;
    }

    const {
      auth,
      userId
    } = await this.getAuthForSessionToken(token); // Getting the session token failed
    // This means that no additional auth is available
    // At this point, just bail out as no additional visibility can be inferred.

    if (!auth || !userId) {
      return false;
    }

    const isSubscriptionSessionTokenMatched = acl.getReadAccess(userId);

    if (isSubscriptionSessionTokenMatched) {
      return true;
    } // Check if the user has any roles that match the ACL


    return Promise.resolve().then(async () => {
      // Resolve false right away if the acl doesn't have any roles
      const acl_has_roles = Object.keys(acl.permissionsById).some(key => key.startsWith('role:'));

      if (!acl_has_roles) {
        return false;
      }

      const roleNames = await auth.getUserRoles(); // Finally, see if any of the user's roles allow them read access

      for (const role of roleNames) {
        // We use getReadAccess as `role` is in the form `role:roleName`
        if (acl.getReadAccess(role)) {
          return true;
        }
      }

      return false;
    }).catch(() => {
      return false;
    });
  }

  async _matchesACL(acl, client, requestId) {
    // Return true directly if ACL isn't present, ACL is public read, or client has master key
    if (!acl || acl.getPublicReadAccess() || client.hasMasterKey) {
      return true;
    } // Check subscription sessionToken matches ACL first


    const subscriptionInfo = client.getSubscriptionInfo(requestId);

    if (typeof subscriptionInfo === 'undefined') {
      return false;
    }

    const subscriptionToken = subscriptionInfo.sessionToken;
    const clientSessionToken = client.sessionToken;

    if (await this._verifyACL(acl, subscriptionToken)) {
      return true;
    }

    if (await this._verifyACL(acl, clientSessionToken)) {
      return true;
    }

    return false;
  }

  _handleConnect(parseWebsocket, request) {
    if (!this._validateKeys(request, this.keyPairs)) {
      _Client.Client.pushError(parseWebsocket, 4, 'Key in request is not valid');

      _logger.default.error('Key in request is not valid');

      return;
    }

    const hasMasterKey = this._hasMasterKey(request, this.keyPairs);

    const clientId = (0, _uuid.default)();
    const client = new _Client.Client(clientId, parseWebsocket, hasMasterKey);
    parseWebsocket.clientId = clientId;
    this.clients.set(parseWebsocket.clientId, client);

    _logger.default.info(`Create new client: ${parseWebsocket.clientId}`);

    client.pushConnect();
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _hasMasterKey(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0 || !validKeyPairs.has('masterKey')) {
      return false;
    }

    if (!request || !request.hasOwnProperty('masterKey')) {
      return false;
    }

    return request.masterKey === validKeyPairs.get('masterKey');
  }

  _validateKeys(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0) {
      return true;
    }

    let isValid = false;

    for (const [key, secret] of validKeyPairs) {
      if (!request[key] || request[key] !== secret) {
        continue;
      }

      isValid = true;
      break;
    }

    return isValid;
  }

  _handleSubscribe(parseWebsocket, request) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before subscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before subscribing');

      return;
    }

    const client = this.clients.get(parseWebsocket.clientId); // Get subscription from subscriptions, create one if necessary

    const subscriptionHash = (0, _QueryTools.queryHash)(request.query); // Add className to subscriptions if necessary

    const className = request.query.className;

    if (!this.subscriptions.has(className)) {
      this.subscriptions.set(className, new Map());
    }

    const classSubscriptions = this.subscriptions.get(className);
    let subscription;

    if (classSubscriptions.has(subscriptionHash)) {
      subscription = classSubscriptions.get(subscriptionHash);
    } else {
      subscription = new _Subscription.Subscription(className, request.query.where, subscriptionHash);
      classSubscriptions.set(subscriptionHash, subscription);
    } // Add subscriptionInfo to client


    const subscriptionInfo = {
      subscription: subscription
    }; // Add selected fields and sessionToken for this subscription if necessary

    if (request.query.fields) {
      subscriptionInfo.fields = request.query.fields;
    }

    if (request.sessionToken) {
      subscriptionInfo.sessionToken = request.sessionToken;
    }

    client.addSubscriptionInfo(request.requestId, subscriptionInfo); // Add clientId to subscription

    subscription.addClientSubscription(parseWebsocket.clientId, request.requestId);
    client.pushSubscribe(request.requestId);

    _logger.default.verbose(`Create client ${parseWebsocket.clientId} new subscription: ${request.requestId}`);

    _logger.default.verbose('Current client number: %d', this.clients.size);

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'subscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _handleUpdateSubscription(parseWebsocket, request) {
    this._handleUnsubscribe(parseWebsocket, request, false);

    this._handleSubscribe(parseWebsocket, request);
  }

  _handleUnsubscribe(parseWebsocket, request, notifyClient = true) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before unsubscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before unsubscribing');

      return;
    }

    const requestId = request.requestId;
    const client = this.clients.get(parseWebsocket.clientId);

    if (typeof client === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find client with clientId ' + parseWebsocket.clientId + '. Make sure you connect to live query server before unsubscribing.');

      _logger.default.error('Can not find this client ' + parseWebsocket.clientId);

      return;
    }

    const subscriptionInfo = client.getSubscriptionInfo(requestId);

    if (typeof subscriptionInfo === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId + '. Make sure you subscribe to live query server before unsubscribing.');

      _logger.default.error('Can not find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId);

      return;
    } // Remove subscription from client


    client.deleteSubscriptionInfo(requestId); // Remove client from subscription

    const subscription = subscriptionInfo.subscription;
    const className = subscription.className;
    subscription.deleteClientSubscription(parseWebsocket.clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

    const classSubscriptions = this.subscriptions.get(className);

    if (!subscription.hasSubscribingClient()) {
      classSubscriptions.delete(subscription.hash);
    } // If there is no subscriptions under this class, remove it from subscriptions


    if (classSubscriptions.size === 0) {
      this.subscriptions.delete(className);
    }

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'unsubscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });

    if (!notifyClient) {
      return;
    }

    client.pushUnsubscribe(request.requestId);

    _logger.default.verbose(`Delete client: ${parseWebsocket.clientId} | subscription: ${request.requestId}`);
  }

}

exports.ParseLiveQueryServer = ParseLiveQueryServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9MaXZlUXVlcnkvUGFyc2VMaXZlUXVlcnlTZXJ2ZXIuanMiXSwibmFtZXMiOlsiUGFyc2VMaXZlUXVlcnlTZXJ2ZXIiLCJjb25zdHJ1Y3RvciIsInNlcnZlciIsImNvbmZpZyIsImNsaWVudHMiLCJNYXAiLCJzdWJzY3JpcHRpb25zIiwiYXBwSWQiLCJQYXJzZSIsImFwcGxpY2F0aW9uSWQiLCJtYXN0ZXJLZXkiLCJrZXlQYWlycyIsImtleSIsIk9iamVjdCIsImtleXMiLCJzZXQiLCJsb2dnZXIiLCJ2ZXJib3NlIiwiZGlzYWJsZVNpbmdsZUluc3RhbmNlIiwic2VydmVyVVJMIiwiaW5pdGlhbGl6ZSIsImphdmFTY3JpcHRLZXkiLCJjYWNoZUNvbnRyb2xsZXIiLCJhdXRoQ2FjaGUiLCJMUlUiLCJtYXgiLCJtYXhBZ2UiLCJwYXJzZVdlYlNvY2tldFNlcnZlciIsIlBhcnNlV2ViU29ja2V0U2VydmVyIiwicGFyc2VXZWJzb2NrZXQiLCJfb25Db25uZWN0Iiwid2Vic29ja2V0VGltZW91dCIsInN1YnNjcmliZXIiLCJQYXJzZVB1YlN1YiIsImNyZWF0ZVN1YnNjcmliZXIiLCJzdWJzY3JpYmUiLCJvbiIsImNoYW5uZWwiLCJtZXNzYWdlU3RyIiwibWVzc2FnZSIsIkpTT04iLCJwYXJzZSIsImUiLCJlcnJvciIsIl9pbmZsYXRlUGFyc2VPYmplY3QiLCJfb25BZnRlclNhdmUiLCJfb25BZnRlckRlbGV0ZSIsImN1cnJlbnRQYXJzZU9iamVjdCIsImNsYXNzTmFtZSIsInBhcnNlT2JqZWN0IiwiX2ZpbmlzaEZldGNoIiwib3JpZ2luYWxQYXJzZU9iamVjdCIsImRlbGV0ZWRQYXJzZU9iamVjdCIsInRvSlNPTiIsImNsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImlkIiwic2l6ZSIsImNsYXNzU3Vic2NyaXB0aW9ucyIsImdldCIsImRlYnVnIiwic3Vic2NyaXB0aW9uIiwidmFsdWVzIiwiaXNTdWJzY3JpcHRpb25NYXRjaGVkIiwiX21hdGNoZXNTdWJzY3JpcHRpb24iLCJjbGllbnRJZCIsInJlcXVlc3RJZHMiLCJfIiwiZW50cmllcyIsImNsaWVudFJlcXVlc3RJZHMiLCJjbGllbnQiLCJyZXF1ZXN0SWQiLCJhY2wiLCJnZXRBQ0wiLCJvcCIsIl9nZXRDTFBPcGVyYXRpb24iLCJxdWVyeSIsIl9tYXRjaGVzQ0xQIiwidGhlbiIsIl9tYXRjaGVzQUNMIiwiaXNNYXRjaGVkIiwicHVzaERlbGV0ZSIsImNhdGNoIiwiaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQiLCJpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkIiwib3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UiLCJQcm9taXNlIiwicmVzb2x2ZSIsIm9yaWdpbmFsQUNMIiwiY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSIsImN1cnJlbnRBQ0wiLCJhbGwiLCJpc09yaWdpbmFsTWF0Y2hlZCIsImlzQ3VycmVudE1hdGNoZWQiLCJoYXNoIiwidHlwZSIsImZ1bmN0aW9uTmFtZSIsInJlcXVlc3QiLCJ0djQiLCJ2YWxpZGF0ZSIsIlJlcXVlc3RTY2hlbWEiLCJDbGllbnQiLCJwdXNoRXJyb3IiLCJfaGFuZGxlQ29ubmVjdCIsIl9oYW5kbGVTdWJzY3JpYmUiLCJfaGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uIiwiX2hhbmRsZVVuc3Vic2NyaWJlIiwiaW5mbyIsImhhcyIsImV2ZW50IiwiZGVsZXRlIiwic3Vic2NyaXB0aW9uSW5mbyIsInN1YnNjcmlwdGlvbkluZm9zIiwiZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uIiwiaGFzU3Vic2NyaWJpbmdDbGllbnQiLCJnZXRBdXRoRm9yU2Vzc2lvblRva2VuIiwic2Vzc2lvblRva2VuIiwiZnJvbUNhY2hlIiwiYXV0aFByb21pc2UiLCJhdXRoIiwidXNlcklkIiwidXNlciIsInJlc3VsdCIsImNvZGUiLCJFcnJvciIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsImRlbCIsIm9iamVjdCIsImdldFN1YnNjcmlwdGlvbkluZm8iLCJhY2xHcm91cCIsInB1c2giLCJTY2hlbWFDb250cm9sbGVyIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwibGVuZ3RoIiwib2JqZWN0SWQiLCJfdmVyaWZ5QUNMIiwidG9rZW4iLCJpc1N1YnNjcmlwdGlvblNlc3Npb25Ub2tlbk1hdGNoZWQiLCJnZXRSZWFkQWNjZXNzIiwiYWNsX2hhc19yb2xlcyIsInBlcm1pc3Npb25zQnlJZCIsInNvbWUiLCJzdGFydHNXaXRoIiwicm9sZU5hbWVzIiwiZ2V0VXNlclJvbGVzIiwicm9sZSIsImdldFB1YmxpY1JlYWRBY2Nlc3MiLCJoYXNNYXN0ZXJLZXkiLCJzdWJzY3JpcHRpb25Ub2tlbiIsImNsaWVudFNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZUtleXMiLCJfaGFzTWFzdGVyS2V5IiwicHVzaENvbm5lY3QiLCJ2YWxpZEtleVBhaXJzIiwiaGFzT3duUHJvcGVydHkiLCJpc1ZhbGlkIiwic2VjcmV0Iiwic3Vic2NyaXB0aW9uSGFzaCIsIlN1YnNjcmlwdGlvbiIsIndoZXJlIiwiZmllbGRzIiwiYWRkU3Vic2NyaXB0aW9uSW5mbyIsImFkZENsaWVudFN1YnNjcmlwdGlvbiIsInB1c2hTdWJzY3JpYmUiLCJub3RpZnlDbGllbnQiLCJkZWxldGVTdWJzY3JpcHRpb25JbmZvIiwicHVzaFVuc3Vic2NyaWJlIl0sIm1hcHBpbmdzIjoiOzs7Ozs7O0FBQUE7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7QUFFQSxNQUFNQSxvQkFBTixDQUEyQjtBQUV6QjtBQUlBO0FBR0FDLEVBQUFBLFdBQVcsQ0FBQ0MsTUFBRCxFQUFjQyxNQUFXLEdBQUcsRUFBNUIsRUFBZ0M7QUFDekMsU0FBS0QsTUFBTCxHQUFjQSxNQUFkO0FBQ0EsU0FBS0UsT0FBTCxHQUFlLElBQUlDLEdBQUosRUFBZjtBQUNBLFNBQUtDLGFBQUwsR0FBcUIsSUFBSUQsR0FBSixFQUFyQjtBQUVBRixJQUFBQSxN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QyxRQUFTLG9CQUN4Q2dDLE9BQU8sQ0FBQzFCLFNBQ1QsRUFISDtBQUtEOztBQXB2QndCIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR2NCBmcm9tICd0djQnO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgU3Vic2NyaXB0aW9uIH0gZnJvbSAnLi9TdWJzY3JpcHRpb24nO1xuaW1wb3J0IHsgQ2xpZW50IH0gZnJvbSAnLi9DbGllbnQnO1xuaW1wb3J0IHsgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIgfSBmcm9tICcuL1BhcnNlV2ViU29ja2V0U2VydmVyJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCBSZXF1ZXN0U2NoZW1hIGZyb20gJy4vUmVxdWVzdFNjaGVtYSc7XG5pbXBvcnQgeyBtYXRjaGVzUXVlcnksIHF1ZXJ5SGFzaCB9IGZyb20gJy4vUXVlcnlUb29scyc7XG5pbXBvcnQgeyBQYXJzZVB1YlN1YiB9IGZyb20gJy4vUGFyc2VQdWJTdWInO1xuaW1wb3J0IFNjaGVtYUNvbnRyb2xsZXIgZnJvbSAnLi4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHV1aWQgZnJvbSAndXVpZCc7XG5pbXBvcnQgeyBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIH0gZnJvbSAnLi4vdHJpZ2dlcnMnO1xuaW1wb3J0IHsgZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiwgQXV0aCB9IGZyb20gJy4uL0F1dGgnO1xuaW1wb3J0IHsgZ2V0Q2FjaGVDb250cm9sbGVyIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IExSVSBmcm9tICdscnUtY2FjaGUnO1xuXG5jbGFzcyBQYXJzZUxpdmVRdWVyeVNlcnZlciB7XG4gIGNsaWVudHM6IE1hcDtcbiAgLy8gY2xhc3NOYW1lIC0+IChxdWVyeUhhc2ggLT4gc3Vic2NyaXB0aW9uKVxuICBzdWJzY3JpcHRpb25zOiBPYmplY3Q7XG4gIHBhcnNlV2ViU29ja2V0U2VydmVyOiBPYmplY3Q7XG4gIGtleVBhaXJzOiBhbnk7XG4gIC8vIFRoZSBzdWJzY3JpYmVyIHdlIHVzZSB0byBnZXQgb2JqZWN0IHVwZGF0ZSBmcm9tIHB1Ymxpc2hlclxuICBzdWJzY3JpYmVyOiBPYmplY3Q7XG5cbiAgY29uc3RydWN0b3Ioc2VydmVyOiBhbnksIGNvbmZpZzogYW55ID0ge30pIHtcbiAgICB0aGlzLnNlcnZlciA9IHNlcnZlcjtcbiAgICB0aGlzLmNsaWVudHMgPSBuZXcgTWFwKCk7XG4gICAgdGhpcy5zdWJzY3JpcHRpb25zID0gbmV3IE1hcCgpO1xuXG4gICAgY29uZmlnLmFwcElkID0gY29uZmlnLmFwcElkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gICAgY29uZmlnLm1hc3RlcktleSA9IGNvbmZpZy5tYXN0ZXJLZXkgfHwgUGFyc2UubWFzdGVyS2V5O1xuXG4gICAgLy8gU3RvcmUga2V5cywgY29udmVydCBvYmogdG8gbWFwXG4gICAgY29uc3Qga2V5UGFpcnMgPSBjb25maWcua2V5UGFpcnMgfHwge307XG4gICAgdGhpcy5rZXlQYWlycyA9IG5ldyBNYXAoKTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhrZXlQYWlycykpIHtcbiAgICAgIHRoaXMua2V5UGFpcnMuc2V0KGtleSwga2V5UGFpcnNba2V5XSk7XG4gICAgfVxuICAgIGxvZ2dlci52ZXJib3NlKCdTdXBwb3J0IGtleSBwYWlycycsIHRoaXMua2V5UGFpcnMpO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBQYXJzZVxuICAgIFBhcnNlLk9iamVjdC5kaXNhYmxlU2luZ2xlSW5zdGFuY2UoKTtcbiAgICBjb25zdCBzZXJ2ZXJVUkwgPSBjb25maWcuc2VydmVyVVJMIHx8IFBhcnNlLnNlcnZlclVSTDtcbiAgICBQYXJzZS5zZXJ2ZXJVUkwgPSBzZXJ2ZXJVUkw7XG4gICAgUGFyc2UuaW5pdGlhbGl6ZShjb25maWcuYXBwSWQsIFBhcnNlLmphdmFTY3JpcHRLZXksIGNvbmZpZy5tYXN0ZXJLZXkpO1xuXG4gICAgLy8gVGhlIGNhY2hlIGNvbnRyb2xsZXIgaXMgYSBwcm9wZXIgY2FjaGUgY29udHJvbGxlclxuICAgIC8vIHdpdGggYWNjZXNzIHRvIFVzZXIgYW5kIFJvbGVzXG4gICAgdGhpcy5jYWNoZUNvbnRyb2xsZXIgPSBnZXRDYWNoZUNvbnRyb2xsZXIoY29uZmlnKTtcblxuICAgIC8vIFRoaXMgYXV0aCBjYWNoZSBzdG9yZXMgdGhlIHByb21pc2VzIGZvciBlYWNoIGF1dGggcmVzb2x1dGlvbi5cbiAgICAvLyBUaGUgbWFpbiBiZW5lZml0IGlzIHRvIGJlIGFibGUgdG8gcmV1c2UgdGhlIHNhbWUgdXNlciAvIHNlc3Npb24gdG9rZW4gcmVzb2x1dGlvbi5cbiAgICB0aGlzLmF1dGhDYWNoZSA9IG5ldyBMUlUoe1xuICAgICAgbWF4OiA1MDAsIC8vIDUwMCBjb25jdXJyZW50XG4gICAgICBtYXhBZ2U6IDYwICogNjAgKiAxMDAwLCAvLyAxaFxuICAgIH0pO1xuICAgIC8vIEluaXRpYWxpemUgd2Vic29ja2V0IHNlcnZlclxuICAgIHRoaXMucGFyc2VXZWJTb2NrZXRTZXJ2ZXIgPSBuZXcgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIoXG4gICAgICBzZXJ2ZXIsXG4gICAgICBwYXJzZVdlYnNvY2tldCA9PiB0aGlzLl9vbkNvbm5lY3QocGFyc2VXZWJzb2NrZXQpLFxuICAgICAgY29uZmlnLndlYnNvY2tldFRpbWVvdXRcbiAgICApO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzdWJzY3JpYmVyXG4gICAgdGhpcy5zdWJzY3JpYmVyID0gUGFyc2VQdWJTdWIuY3JlYXRlU3Vic2NyaWJlcihjb25maWcpO1xuICAgIHRoaXMuc3Vic2NyaWJlci5zdWJzY3JpYmUoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKTtcbiAgICB0aGlzLnN1YnNjcmliZXIuc3Vic2NyaWJlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUnKTtcbiAgICAvLyBSZWdpc3RlciBtZXNzYWdlIGhhbmRsZXIgZm9yIHN1YnNjcmliZXIuIFdoZW4gcHVibGlzaGVyIGdldCBtZXNzYWdlcywgaXQgd2lsbCBwdWJsaXNoIG1lc3NhZ2VcbiAgICAvLyB0byB0aGUgc3Vic2NyaWJlcnMgYW5kIHRoZSBoYW5kbGVyIHdpbGwgYmUgY2FsbGVkLlxuICAgIHRoaXMuc3Vic2NyaWJlci5vbignbWVzc2FnZScsIChjaGFubmVsLCBtZXNzYWdlU3RyKSA9PiB7XG4gICAgICBsb2dnZXIudmVyYm9zZSgnU3Vic2NyaWJlIG1lc3NzYWdlICVqJywgbWVzc2FnZVN0cik7XG4gICAgICBsZXQgbWVzc2FnZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG1lc3NhZ2UgPSBKU09OLnBhcnNlKG1lc3NhZ2VTdHIpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSBtZXNzYWdlJywgbWVzc2FnZVN0ciwgZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2luZmxhdGVQYXJzZU9iamVjdChtZXNzYWdlKTtcbiAgICAgIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyU2F2ZScpIHtcbiAgICAgICAgdGhpcy5fb25BZnRlclNhdmUobWVzc2FnZSk7XG4gICAgICB9IGVsc2UgaWYgKGNoYW5uZWwgPT09IFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJEZWxldGUobWVzc2FnZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICAgJ0dldCBtZXNzYWdlICVzIGZyb20gdW5rbm93biBjaGFubmVsICVqJyxcbiAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgIGNoYW5uZWxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgSlNPTiBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0IEpTT04uXG4gIF9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgLy8gSW5mbGF0ZSBtZXJnZWQgb2JqZWN0XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3Q7XG4gICAgbGV0IGNsYXNzTmFtZSA9IGN1cnJlbnRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbGV0IHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgIHBhcnNlT2JqZWN0Ll9maW5pc2hGZXRjaChjdXJyZW50UGFyc2VPYmplY3QpO1xuICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgLy8gSW5mbGF0ZSBvcmlnaW5hbCBvYmplY3RcbiAgICBjb25zdCBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0O1xuICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICBjbGFzc05hbWUgPSBvcmlnaW5hbFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICAgIHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKG9yaWdpbmFsUGFyc2VPYmplY3QpO1xuICAgICAgbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBfb25BZnRlckRlbGV0ZShtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICBsb2dnZXIudmVyYm9zZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgY29uc3QgZGVsZXRlZFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgY29uc3QgY2xhc3NMZXZlbFBlcm1pc3Npb25zID0gbWVzc2FnZS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gZGVsZXRlZFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICdDbGFzc05hbWU6ICVqIHwgT2JqZWN0SWQ6ICVzJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIGRlbGV0ZWRQYXJzZU9iamVjdC5pZFxuICAgICk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzU3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oXG4gICAgICAgIGRlbGV0ZWRQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgaWYgKCFpc1N1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKFxuICAgICAgICBzdWJzY3JpcHRpb24uY2xpZW50UmVxdWVzdElkc1xuICAgICAgKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCByZXF1ZXN0SWQgb2YgcmVxdWVzdElkcykge1xuICAgICAgICAgIGNvbnN0IGFjbCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgIC8vIENoZWNrIENMUFxuICAgICAgICAgIGNvbnN0IG9wID0gdGhpcy5fZ2V0Q0xQT3BlcmF0aW9uKHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gICAgICAgICAgdGhpcy5fbWF0Y2hlc0NMUChcbiAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgb3BcbiAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIC8vIENoZWNrIEFDTFxuICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbWF0Y2hlc0FDTChhY2wsIGNsaWVudCwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihpc01hdGNoZWQgPT4ge1xuICAgICAgICAgICAgICBpZiAoIWlzTWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNsaWVudC5wdXNoRGVsZXRlKHJlcXVlc3RJZCwgZGVsZXRlZFBhcnNlT2JqZWN0KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICBsb2dnZXIuZXJyb3IoJ01hdGNoaW5nIEFDTCBlcnJvciA6ICcsIGVycm9yKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBfb25BZnRlclNhdmUobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgbG9nZ2VyLnZlcmJvc2UoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUgaXMgdHJpZ2dlcmVkJyk7XG5cbiAgICBsZXQgb3JpZ2luYWxQYXJzZU9iamVjdCA9IG51bGw7XG4gICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NMZXZlbFBlcm1pc3Npb25zID0gbWVzc2FnZS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gY3VycmVudFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICdDbGFzc05hbWU6ICVzIHwgT2JqZWN0SWQ6ICVzJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIGN1cnJlbnRQYXJzZU9iamVjdC5pZFxuICAgICk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgY29uc3QgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oXG4gICAgICAgIGN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCBbY2xpZW50SWQsIHJlcXVlc3RJZHNdIG9mIF8uZW50cmllcyhcbiAgICAgICAgc3Vic2NyaXB0aW9uLmNsaWVudFJlcXVlc3RJZHNcbiAgICAgICkpIHtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgcmVxdWVzdElkIG9mIHJlcXVlc3RJZHMpIHtcbiAgICAgICAgICAvLyBTZXQgb3JpZ25hbCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlO1xuICAgICAgICAgIGlmICghaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IG9yaWdpbmFsQUNMO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC5nZXRBQ0woKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChcbiAgICAgICAgICAgICAgb3JpZ2luYWxBQ0wsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBTZXQgY3VycmVudCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkKSB7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgY3VycmVudEFDTCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSA9IHRoaXMuX21hdGNoZXNBQ0woXG4gICAgICAgICAgICAgIGN1cnJlbnRBQ0wsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBvcCA9IHRoaXMuX2dldENMUE9wZXJhdGlvbihzdWJzY3JpcHRpb24ucXVlcnkpO1xuICAgICAgICAgIHRoaXMuX21hdGNoZXNDTFAoXG4gICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgIG9wXG4gICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlLFxuICAgICAgICAgICAgICAgIGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UsXG4gICAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC50aGVuKFxuICAgICAgICAgICAgICAoW2lzT3JpZ2luYWxNYXRjaGVkLCBpc0N1cnJlbnRNYXRjaGVkXSkgPT4ge1xuICAgICAgICAgICAgICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgICAgICAgICAgICAgJ09yaWdpbmFsICVqIHwgQ3VycmVudCAlaiB8IE1hdGNoOiAlcywgJXMsICVzLCAlcyB8IFF1ZXJ5OiAlcycsXG4gICAgICAgICAgICAgICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkLFxuICAgICAgICAgICAgICAgICAgaXNPcmlnaW5hbE1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc0N1cnJlbnRNYXRjaGVkLFxuICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uLmhhc2hcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy8gRGVjaWRlIGV2ZW50IHR5cGVcbiAgICAgICAgICAgICAgICBsZXQgdHlwZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNPcmlnaW5hbE1hdGNoZWQgJiYgaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9ICdVcGRhdGUnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaXNPcmlnaW5hbE1hdGNoZWQgJiYgIWlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICAgIHR5cGUgPSAnTGVhdmUnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGUgPSAnRW50ZXInO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZSA9ICdDcmVhdGUnO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25OYW1lID0gJ3B1c2gnICsgdHlwZTtcbiAgICAgICAgICAgICAgICBjbGllbnRbZnVuY3Rpb25OYW1lXShyZXF1ZXN0SWQsIGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIGVycm9yID0+IHtcbiAgICAgICAgICAgICAgICBsb2dnZXIuZXJyb3IoJ01hdGNoaW5nIEFDTCBlcnJvciA6ICcsIGVycm9yKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIF9vbkNvbm5lY3QocGFyc2VXZWJzb2NrZXQ6IGFueSk6IHZvaWQge1xuICAgIHBhcnNlV2Vic29ja2V0Lm9uKCdtZXNzYWdlJywgcmVxdWVzdCA9PiB7XG4gICAgICBpZiAodHlwZW9mIHJlcXVlc3QgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVxdWVzdCA9IEpTT04ucGFyc2UocmVxdWVzdCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSByZXF1ZXN0JywgcmVxdWVzdCwgZSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBsb2dnZXIudmVyYm9zZSgnUmVxdWVzdDogJWonLCByZXF1ZXN0KTtcblxuICAgICAgLy8gQ2hlY2sgd2hldGhlciB0aGlzIHJlcXVlc3QgaXMgYSB2YWxpZCByZXF1ZXN0LCByZXR1cm4gZXJyb3IgZGlyZWN0bHkgaWYgbm90XG4gICAgICBpZiAoXG4gICAgICAgICF0djQudmFsaWRhdGUocmVxdWVzdCwgUmVxdWVzdFNjaGVtYVsnZ2VuZXJhbCddKSB8fFxuICAgICAgICAhdHY0LnZhbGlkYXRlKHJlcXVlc3QsIFJlcXVlc3RTY2hlbWFbcmVxdWVzdC5vcF0pXG4gICAgICApIHtcbiAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMSwgdHY0LmVycm9yLm1lc3NhZ2UpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0Nvbm5lY3QgbWVzc2FnZSBlcnJvciAlcycsIHR2NC5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzd2l0Y2ggKHJlcXVlc3Qub3ApIHtcbiAgICAgICAgY2FzZSAnY29ubmVjdCc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlQ29ubmVjdChwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ3N1YnNjcmliZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICB0aGlzLl9oYW5kbGVVcGRhdGVTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICd1bnN1YnNjcmliZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDMsICdHZXQgdW5rbm93biBvcGVyYXRpb24nKTtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0dldCB1bmtub3duIG9wZXJhdGlvbicsIHJlcXVlc3Qub3ApO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcGFyc2VXZWJzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCAoKSA9PiB7XG4gICAgICBsb2dnZXIuaW5mbyhgQ2xpZW50IGRpc2Nvbm5lY3Q6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9YCk7XG4gICAgICBjb25zdCBjbGllbnRJZCA9IHBhcnNlV2Vic29ja2V0LmNsaWVudElkO1xuICAgICAgaWYgKCF0aGlzLmNsaWVudHMuaGFzKGNsaWVudElkKSkge1xuICAgICAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgICAgICBldmVudDogJ3dzX2Rpc2Nvbm5lY3RfZXJyb3InLFxuICAgICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgICAgICAgIGVycm9yOiBgVW5hYmxlIHRvIGZpbmQgY2xpZW50ICR7Y2xpZW50SWR9YCxcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgQ2FuIG5vdCBmaW5kIGNsaWVudCAke2NsaWVudElkfSBvbiBkaXNjb25uZWN0YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gRGVsZXRlIGNsaWVudFxuICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICB0aGlzLmNsaWVudHMuZGVsZXRlKGNsaWVudElkKTtcblxuICAgICAgLy8gRGVsZXRlIGNsaWVudCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICAgIGZvciAoY29uc3QgW3JlcXVlc3RJZCwgc3Vic2NyaXB0aW9uSW5mb10gb2YgXy5lbnRyaWVzKFxuICAgICAgICBjbGllbnQuc3Vic2NyaXB0aW9uSW5mb3NcbiAgICAgICkpIHtcbiAgICAgICAgY29uc3Qgc3Vic2NyaXB0aW9uID0gc3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgICAgIHN1YnNjcmlwdGlvbi5kZWxldGVDbGllbnRTdWJzY3JpcHRpb24oY2xpZW50SWQsIHJlcXVlc3RJZCk7XG5cbiAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xpZW50IHdoaWNoIGlzIHN1YnNjcmliaW5nIHRoaXMgc3Vic2NyaXB0aW9uLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoXG4gICAgICAgICAgc3Vic2NyaXB0aW9uLmNsYXNzTmFtZVxuICAgICAgICApO1xuICAgICAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLmRlbGV0ZShzdWJzY3JpcHRpb24uaGFzaCk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuc2l6ZSA9PT0gMCkge1xuICAgICAgICAgIHRoaXMuc3Vic2NyaXB0aW9ucy5kZWxldGUoc3Vic2NyaXB0aW9uLmNsYXNzTmFtZSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50cyAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcbiAgICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IHN1YnNjcmlwdGlvbnMgJWQnLCB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSk7XG4gICAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgICAgZXZlbnQ6ICd3c19kaXNjb25uZWN0JyxcbiAgICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnd3NfY29ubmVjdCcsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuICB9XG5cbiAgX21hdGNoZXNTdWJzY3JpcHRpb24ocGFyc2VPYmplY3Q6IGFueSwgc3Vic2NyaXB0aW9uOiBhbnkpOiBib29sZWFuIHtcbiAgICAvLyBPYmplY3QgaXMgdW5kZWZpbmVkIG9yIG51bGwsIG5vdCBtYXRjaFxuICAgIGlmICghcGFyc2VPYmplY3QpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIG1hdGNoZXNRdWVyeShwYXJzZU9iamVjdCwgc3Vic2NyaXB0aW9uLnF1ZXJ5KTtcbiAgfVxuXG4gIGdldEF1dGhGb3JTZXNzaW9uVG9rZW4oXG4gICAgc2Vzc2lvblRva2VuOiA/c3RyaW5nXG4gICk6IFByb21pc2U8eyBhdXRoOiA/QXV0aCwgdXNlcklkOiA/c3RyaW5nIH0+IHtcbiAgICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gICAgfVxuICAgIGNvbnN0IGZyb21DYWNoZSA9IHRoaXMuYXV0aENhY2hlLmdldChzZXNzaW9uVG9rZW4pO1xuICAgIGlmIChmcm9tQ2FjaGUpIHtcbiAgICAgIHJldHVybiBmcm9tQ2FjaGU7XG4gICAgfVxuICAgIGNvbnN0IGF1dGhQcm9taXNlID0gZ2V0QXV0aEZvclNlc3Npb25Ub2tlbih7XG4gICAgICBjYWNoZUNvbnRyb2xsZXI6IHRoaXMuY2FjaGVDb250cm9sbGVyLFxuICAgICAgc2Vzc2lvblRva2VuOiBzZXNzaW9uVG9rZW4sXG4gICAgfSlcbiAgICAgIC50aGVuKGF1dGggPT4ge1xuICAgICAgICByZXR1cm4geyBhdXRoLCB1c2VySWQ6IGF1dGggJiYgYXV0aC51c2VyICYmIGF1dGgudXNlci5pZCB9O1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIFRoZXJlIHdhcyBhbiBlcnJvciB3aXRoIHRoZSBzZXNzaW9uIHRva2VuXG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHt9O1xuICAgICAgICBpZiAoZXJyb3IgJiYgZXJyb3IuY29kZSA9PT0gUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOKSB7XG4gICAgICAgICAgLy8gU3RvcmUgYSByZXNvbHZlZCBwcm9taXNlIHdpdGggdGhlIGVycm9yIGZvciAxMCBtaW51dGVzXG4gICAgICAgICAgcmVzdWx0LmVycm9yID0gZXJyb3I7XG4gICAgICAgICAgdGhpcy5hdXRoQ2FjaGUuc2V0KFxuICAgICAgICAgICAgc2Vzc2lvblRva2VuLFxuICAgICAgICAgICAgUHJvbWlzZS5yZXNvbHZlKHJlc3VsdCksXG4gICAgICAgICAgICA2MCAqIDEwICogMTAwMFxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5hdXRoQ2FjaGUuZGVsKHNlc3Npb25Ub2tlbik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgIH0pO1xuICAgIHRoaXMuYXV0aENhY2hlLnNldChzZXNzaW9uVG9rZW4sIGF1dGhQcm9taXNlKTtcbiAgICByZXR1cm4gYXV0aFByb21pc2U7XG4gIH1cblxuICBhc3luYyBfbWF0Y2hlc0NMUChcbiAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM6ID9hbnksXG4gICAgb2JqZWN0OiBhbnksXG4gICAgY2xpZW50OiBhbnksXG4gICAgcmVxdWVzdElkOiBudW1iZXIsXG4gICAgb3A6IHN0cmluZ1xuICApOiBhbnkge1xuICAgIC8vIHRyeSB0byBtYXRjaCBvbiB1c2VyIGZpcnN0LCBsZXNzIGV4cGVuc2l2ZSB0aGFuIHdpdGggcm9sZXNcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBjb25zdCBhY2xHcm91cCA9IFsnKiddO1xuICAgIGxldCB1c2VySWQ7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgY29uc3QgeyB1c2VySWQgfSA9IGF3YWl0IHRoaXMuZ2V0QXV0aEZvclNlc3Npb25Ub2tlbihcbiAgICAgICAgc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW5cbiAgICAgICk7XG4gICAgICBpZiAodXNlcklkKSB7XG4gICAgICAgIGFjbEdyb3VwLnB1c2godXNlcklkKTtcbiAgICAgIH1cbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IFNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKFxuICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgIG9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgIGFjbEdyb3VwLFxuICAgICAgICBvcFxuICAgICAgKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZ2dlci52ZXJib3NlKGBGYWlsZWQgbWF0Y2hpbmcgQ0xQIGZvciAke29iamVjdC5pZH0gJHt1c2VySWR9ICR7ZX1gKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgLy8gVE9ETzogaGFuZGxlIHJvbGVzIHBlcm1pc3Npb25zXG4gICAgLy8gT2JqZWN0LmtleXMoY2xhc3NMZXZlbFBlcm1pc3Npb25zKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAvLyAgIGNvbnN0IHBlcm0gPSBjbGFzc0xldmVsUGVybWlzc2lvbnNba2V5XTtcbiAgICAvLyAgIE9iamVjdC5rZXlzKHBlcm0pLmZvckVhY2goKGtleSkgPT4ge1xuICAgIC8vICAgICBpZiAoa2V5LmluZGV4T2YoJ3JvbGUnKSlcbiAgICAvLyAgIH0pO1xuICAgIC8vIH0pXG4gICAgLy8gLy8gaXQncyByZWplY3RlZCBoZXJlLCBjaGVjayB0aGUgcm9sZXNcbiAgICAvLyB2YXIgcm9sZXNRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShQYXJzZS5Sb2xlKTtcbiAgICAvLyByb2xlc1F1ZXJ5LmVxdWFsVG8oXCJ1c2Vyc1wiLCB1c2VyKTtcbiAgICAvLyByZXR1cm4gcm9sZXNRdWVyeS5maW5kKHt1c2VNYXN0ZXJLZXk6dHJ1ZX0pO1xuICB9XG5cbiAgX2dldENMUE9wZXJhdGlvbihxdWVyeTogYW55KSB7XG4gICAgcmV0dXJuIHR5cGVvZiBxdWVyeSA9PT0gJ29iamVjdCcgJiZcbiAgICAgIE9iamVjdC5rZXlzKHF1ZXJ5KS5sZW5ndGggPT0gMSAmJlxuICAgICAgdHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJ1xuICAgICAgPyAnZ2V0J1xuICAgICAgOiAnZmluZCc7XG4gIH1cblxuICBhc3luYyBfdmVyaWZ5QUNMKGFjbDogYW55LCB0b2tlbjogc3RyaW5nKSB7XG4gICAgaWYgKCF0b2tlbikge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IHsgYXV0aCwgdXNlcklkIH0gPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4odG9rZW4pO1xuXG4gICAgLy8gR2V0dGluZyB0aGUgc2Vzc2lvbiB0b2tlbiBmYWlsZWRcbiAgICAvLyBUaGlzIG1lYW5zIHRoYXQgbm8gYWRkaXRpb25hbCBhdXRoIGlzIGF2YWlsYWJsZVxuICAgIC8vIEF0IHRoaXMgcG9pbnQsIGp1c3QgYmFpbCBvdXQgYXMgbm8gYWRkaXRpb25hbCB2aXNpYmlsaXR5IGNhbiBiZSBpbmZlcnJlZC5cbiAgICBpZiAoIWF1dGggfHwgIXVzZXJJZCkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBjb25zdCBpc1N1YnNjcmlwdGlvblNlc3Npb25Ub2tlbk1hdGNoZWQgPSBhY2wuZ2V0UmVhZEFjY2Vzcyh1c2VySWQpO1xuICAgIGlmIChpc1N1YnNjcmlwdGlvblNlc3Npb25Ub2tlbk1hdGNoZWQpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8vIENoZWNrIGlmIHRoZSB1c2VyIGhhcyBhbnkgcm9sZXMgdGhhdCBtYXRjaCB0aGUgQUNMXG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpXG4gICAgICAudGhlbihhc3luYyAoKSA9PiB7XG4gICAgICAgIC8vIFJlc29sdmUgZmFsc2UgcmlnaHQgYXdheSBpZiB0aGUgYWNsIGRvZXNuJ3QgaGF2ZSBhbnkgcm9sZXNcbiAgICAgICAgY29uc3QgYWNsX2hhc19yb2xlcyA9IE9iamVjdC5rZXlzKGFjbC5wZXJtaXNzaW9uc0J5SWQpLnNvbWUoa2V5ID0+XG4gICAgICAgICAga2V5LnN0YXJ0c1dpdGgoJ3JvbGU6JylcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFhY2xfaGFzX3JvbGVzKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgcm9sZU5hbWVzID0gYXdhaXQgYXV0aC5nZXRVc2VyUm9sZXMoKTtcbiAgICAgICAgLy8gRmluYWxseSwgc2VlIGlmIGFueSBvZiB0aGUgdXNlcidzIHJvbGVzIGFsbG93IHRoZW0gcmVhZCBhY2Nlc3NcbiAgICAgICAgZm9yIChjb25zdCByb2xlIG9mIHJvbGVOYW1lcykge1xuICAgICAgICAgIC8vIFdlIHVzZSBnZXRSZWFkQWNjZXNzIGFzIGByb2xlYCBpcyBpbiB0aGUgZm9ybSBgcm9sZTpyb2xlTmFtZWBcbiAgICAgICAgICBpZiAoYWNsLmdldFJlYWRBY2Nlc3Mocm9sZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBfbWF0Y2hlc0FDTChcbiAgICBhY2w6IGFueSxcbiAgICBjbGllbnQ6IGFueSxcbiAgICByZXF1ZXN0SWQ6IG51bWJlclxuICApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICAvLyBSZXR1cm4gdHJ1ZSBkaXJlY3RseSBpZiBBQ0wgaXNuJ3QgcHJlc2VudCwgQUNMIGlzIHB1YmxpYyByZWFkLCBvciBjbGllbnQgaGFzIG1hc3RlciBrZXlcbiAgICBpZiAoIWFjbCB8fCBhY2wuZ2V0UHVibGljUmVhZEFjY2VzcygpIHx8IGNsaWVudC5oYXNNYXN0ZXJLZXkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICAvLyBDaGVjayBzdWJzY3JpcHRpb24gc2Vzc2lvblRva2VuIG1hdGNoZXMgQUNMIGZpcnN0XG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvID09PSAndW5kZWZpbmVkJykge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvblRva2VuID0gc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW47XG4gICAgY29uc3QgY2xpZW50U2Vzc2lvblRva2VuID0gY2xpZW50LnNlc3Npb25Ub2tlbjtcblxuICAgIGlmIChhd2FpdCB0aGlzLl92ZXJpZnlBQ0woYWNsLCBzdWJzY3JpcHRpb25Ub2tlbikpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGlmIChhd2FpdCB0aGlzLl92ZXJpZnlBQ0woYWNsLCBjbGllbnRTZXNzaW9uVG9rZW4pKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBfaGFuZGxlQ29ubmVjdChwYXJzZVdlYnNvY2tldDogYW55LCByZXF1ZXN0OiBhbnkpOiBhbnkge1xuICAgIGlmICghdGhpcy5fdmFsaWRhdGVLZXlzKHJlcXVlc3QsIHRoaXMua2V5UGFpcnMpKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCA0LCAnS2V5IGluIHJlcXVlc3QgaXMgbm90IHZhbGlkJyk7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0tleSBpbiByZXF1ZXN0IGlzIG5vdCB2YWxpZCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBoYXNNYXN0ZXJLZXkgPSB0aGlzLl9oYXNNYXN0ZXJLZXkocmVxdWVzdCwgdGhpcy5rZXlQYWlycyk7XG4gICAgY29uc3QgY2xpZW50SWQgPSB1dWlkKCk7XG4gICAgY29uc3QgY2xpZW50ID0gbmV3IENsaWVudChjbGllbnRJZCwgcGFyc2VXZWJzb2NrZXQsIGhhc01hc3RlcktleSk7XG4gICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgPSBjbGllbnRJZDtcbiAgICB0aGlzLmNsaWVudHMuc2V0KHBhcnNlV2Vic29ja2V0LmNsaWVudElkLCBjbGllbnQpO1xuICAgIGxvZ2dlci5pbmZvKGBDcmVhdGUgbmV3IGNsaWVudDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH1gKTtcbiAgICBjbGllbnQucHVzaENvbm5lY3QoKTtcbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnY29ubmVjdCcsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuICB9XG5cbiAgX2hhc01hc3RlcktleShyZXF1ZXN0OiBhbnksIHZhbGlkS2V5UGFpcnM6IGFueSk6IGJvb2xlYW4ge1xuICAgIGlmIChcbiAgICAgICF2YWxpZEtleVBhaXJzIHx8XG4gICAgICB2YWxpZEtleVBhaXJzLnNpemUgPT0gMCB8fFxuICAgICAgIXZhbGlkS2V5UGFpcnMuaGFzKCdtYXN0ZXJLZXknKVxuICAgICkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAoIXJlcXVlc3QgfHwgIXJlcXVlc3QuaGFzT3duUHJvcGVydHkoJ21hc3RlcktleScpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiByZXF1ZXN0Lm1hc3RlcktleSA9PT0gdmFsaWRLZXlQYWlycy5nZXQoJ21hc3RlcktleScpO1xuICB9XG5cbiAgX3ZhbGlkYXRlS2V5cyhyZXF1ZXN0OiBhbnksIHZhbGlkS2V5UGFpcnM6IGFueSk6IGJvb2xlYW4ge1xuICAgIGlmICghdmFsaWRLZXlQYWlycyB8fCB2YWxpZEtleVBhaXJzLnNpemUgPT0gMCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGxldCBpc1ZhbGlkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBba2V5LCBzZWNyZXRdIG9mIHZhbGlkS2V5UGFpcnMpIHtcbiAgICAgIGlmICghcmVxdWVzdFtrZXldIHx8IHJlcXVlc3Rba2V5XSAhPT0gc2VjcmV0KSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaXNWYWxpZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIGlzVmFsaWQ7XG4gIH1cblxuICBfaGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IGFueSB7XG4gICAgLy8gSWYgd2UgY2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCByZXR1cm4gZXJyb3IgdG8gY2xpZW50XG4gICAgaWYgKCFwYXJzZVdlYnNvY2tldC5oYXNPd25Qcm9wZXJ0eSgnY2xpZW50SWQnKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgc3Vic2NyaWJpbmcnXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KHBhcnNlV2Vic29ja2V0LmNsaWVudElkKTtcblxuICAgIC8vIEdldCBzdWJzY3JpcHRpb24gZnJvbSBzdWJzY3JpcHRpb25zLCBjcmVhdGUgb25lIGlmIG5lY2Vzc2FyeVxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkhhc2ggPSBxdWVyeUhhc2gocmVxdWVzdC5xdWVyeSk7XG4gICAgLy8gQWRkIGNsYXNzTmFtZSB0byBzdWJzY3JpcHRpb25zIGlmIG5lY2Vzc2FyeVxuICAgIGNvbnN0IGNsYXNzTmFtZSA9IHJlcXVlc3QucXVlcnkuY2xhc3NOYW1lO1xuICAgIGlmICghdGhpcy5zdWJzY3JpcHRpb25zLmhhcyhjbGFzc05hbWUpKSB7XG4gICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuc2V0KGNsYXNzTmFtZSwgbmV3IE1hcCgpKTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGxldCBzdWJzY3JpcHRpb247XG4gICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5oYXMoc3Vic2NyaXB0aW9uSGFzaCkpIHtcbiAgICAgIHN1YnNjcmlwdGlvbiA9IGNsYXNzU3Vic2NyaXB0aW9ucy5nZXQoc3Vic2NyaXB0aW9uSGFzaCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN1YnNjcmlwdGlvbiA9IG5ldyBTdWJzY3JpcHRpb24oXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgcmVxdWVzdC5xdWVyeS53aGVyZSxcbiAgICAgICAgc3Vic2NyaXB0aW9uSGFzaFxuICAgICAgKTtcbiAgICAgIGNsYXNzU3Vic2NyaXB0aW9ucy5zZXQoc3Vic2NyaXB0aW9uSGFzaCwgc3Vic2NyaXB0aW9uKTtcbiAgICB9XG5cbiAgICAvLyBBZGQgc3Vic2NyaXB0aW9uSW5mbyB0byBjbGllbnRcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0ge1xuICAgICAgc3Vic2NyaXB0aW9uOiBzdWJzY3JpcHRpb24sXG4gICAgfTtcbiAgICAvLyBBZGQgc2VsZWN0ZWQgZmllbGRzIGFuZCBzZXNzaW9uVG9rZW4gZm9yIHRoaXMgc3Vic2NyaXB0aW9uIGlmIG5lY2Vzc2FyeVxuICAgIGlmIChyZXF1ZXN0LnF1ZXJ5LmZpZWxkcykge1xuICAgICAgc3Vic2NyaXB0aW9uSW5mby5maWVsZHMgPSByZXF1ZXN0LnF1ZXJ5LmZpZWxkcztcbiAgICB9XG4gICAgaWYgKHJlcXVlc3Quc2Vzc2lvblRva2VuKSB7XG4gICAgICBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbiA9IHJlcXVlc3Quc2Vzc2lvblRva2VuO1xuICAgIH1cbiAgICBjbGllbnQuYWRkU3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0LnJlcXVlc3RJZCwgc3Vic2NyaXB0aW9uSW5mbyk7XG5cbiAgICAvLyBBZGQgY2xpZW50SWQgdG8gc3Vic2NyaXB0aW9uXG4gICAgc3Vic2NyaXB0aW9uLmFkZENsaWVudFN1YnNjcmlwdGlvbihcbiAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkLFxuICAgICAgcmVxdWVzdC5yZXF1ZXN0SWRcbiAgICApO1xuXG4gICAgY2xpZW50LnB1c2hTdWJzY3JpYmUocmVxdWVzdC5yZXF1ZXN0SWQpO1xuXG4gICAgbG9nZ2VyLnZlcmJvc2UoXG4gICAgICBgQ3JlYXRlIGNsaWVudCAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfSBuZXcgc3Vic2NyaXB0aW9uOiAke1xuICAgICAgICByZXF1ZXN0LnJlcXVlc3RJZFxuICAgICAgfWBcbiAgICApO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudCBudW1iZXI6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICdzdWJzY3JpYmUnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcbiAgfVxuXG4gIF9oYW5kbGVVcGRhdGVTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogYW55IHtcbiAgICB0aGlzLl9oYW5kbGVVbnN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCwgZmFsc2UpO1xuICAgIHRoaXMuX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gIH1cblxuICBfaGFuZGxlVW5zdWJzY3JpYmUoXG4gICAgcGFyc2VXZWJzb2NrZXQ6IGFueSxcbiAgICByZXF1ZXN0OiBhbnksXG4gICAgbm90aWZ5Q2xpZW50OiBib29sZWFuID0gdHJ1ZVxuICApOiBhbnkge1xuICAgIC8vIElmIHdlIGNhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgcmV0dXJuIGVycm9yIHRvIGNsaWVudFxuICAgIGlmICghcGFyc2VXZWJzb2NrZXQuaGFzT3duUHJvcGVydHkoJ2NsaWVudElkJykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3RJZCA9IHJlcXVlc3QucmVxdWVzdElkO1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW5ub3QgZmluZCBjbGllbnQgd2l0aCBjbGllbnRJZCAnICtcbiAgICAgICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICAgJy4gTWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIGxpdmUgcXVlcnkgc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nLidcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCAnICsgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2Fubm90IGZpbmQgc3Vic2NyaXB0aW9uIHdpdGggY2xpZW50SWQgJyArXG4gICAgICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAgICcgc3Vic2NyaXB0aW9uSWQgJyArXG4gICAgICAgICAgcmVxdWVzdElkICtcbiAgICAgICAgICAnLiBNYWtlIHN1cmUgeW91IHN1YnNjcmliZSB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgK1xuICAgICAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkICtcbiAgICAgICAgICAnIHN1YnNjcmlwdGlvbklkICcgK1xuICAgICAgICAgIHJlcXVlc3RJZFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgc3Vic2NyaXB0aW9uIGZyb20gY2xpZW50XG4gICAgY2xpZW50LmRlbGV0ZVN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICAvLyBSZW1vdmUgY2xpZW50IGZyb20gc3Vic2NyaXB0aW9uXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uID0gc3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgY29uc3QgY2xhc3NOYW1lID0gc3Vic2NyaXB0aW9uLmNsYXNzTmFtZTtcbiAgICBzdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LmNsaWVudElkLCByZXF1ZXN0SWQpO1xuICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsaWVudCB3aGljaCBpcyBzdWJzY3JpYmluZyB0aGlzIHN1YnNjcmlwdGlvbiwgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5oYXNoKTtcbiAgICB9XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5zaXplID09PSAwKSB7XG4gICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKGNsYXNzTmFtZSk7XG4gICAgfVxuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICd1bnN1YnNjcmliZScsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuXG4gICAgaWYgKCFub3RpZnlDbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjbGllbnQucHVzaFVuc3Vic2NyaWJlKHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgYERlbGV0ZSBjbGllbnQ6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9IHwgc3Vic2NyaXB0aW9uOiAke1xuICAgICAgICByZXF1ZXN0LnJlcXVlc3RJZFxuICAgICAgfWBcbiAgICApO1xuICB9XG59XG5cbmV4cG9ydCB7IFBhcnNlTGl2ZVF1ZXJ5U2VydmVyIH07XG4iXX0=