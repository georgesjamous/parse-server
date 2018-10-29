'use strict';
const Parse = require('parse/node');

describe('ReadonlyTrigger tests', () => {
  it('beforeSave should be read only', async () => {
    Parse.Cloud.beforeSave('_Session', function(req) {
      console.log('object', req.object.toJSON());
      req.object.set('KeyA', 'EDITED_VALUE');
      req.object.set('KeyB', 'EDITED_VALUE');
    });
    const user = new Parse.User();
    user.setUsername('some-user-name');
    user.setPassword('password');
    await user.signUp();
    const query = new Parse.Query('_Session');
    query.equalTo('user', user);
    const sessionObject = await query.first({
      useMasterKey: true,
    });
    expect(sessionObject.get('KeyA')).toBeUndefined();
    expect(sessionObject.get('KeyB')).toBeUndefined();
    expect(sessionObject.get('user')).toBeDefined();
    expect(sessionObject.get('sessionToken')).toBeDefined();
  });
  it('beforeSave should fail on throw', async () => {
    Parse.Cloud.beforeSave('_Session', function() {
      throw new Parse.Error(12345678, 'Nop');
    });
    try {
      const user = new Parse.User();
      user.setUsername('some-user-name');
      user.setPassword('password');
      await user.signUp();
    } catch (error) {
      expect(error.code).toBe(12345678);
      expect(error.message).toBe('Nop');
    }
    const query = new Parse.Query('_User');
    query.equalTo('username', 'some-user-name');
    const user = await query.first({
      useMasterKey: true,
    });
    expect(user).toBeDefined();
  });
  it('beforeDelete should ignore thrown error', async () => {
    Parse.Cloud.beforeDelete('_Session', function() {
      throw new Parse.Error(12345678, 'Nop');
    });
    const user = new Parse.User();
    user.setUsername('some-user-name');
    user.setPassword('password');
    await user.signUp();
    try {
      await user.destroy({ useMasterKey: true });
    } catch (error) {
      throw error;
    }
  });
  it('[Example] prevent a user from logging in if he has not paid', async () => {
    Parse.Cloud.beforeSave('_Session', function() {
      throw new Parse.Error(12345678, 'Nop');
    });
    const user = new Parse.User();
    user.setUsername('some-user-name');
    user.setPassword('password');
    await user.signUp();
  });
});
