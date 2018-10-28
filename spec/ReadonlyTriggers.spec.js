// 'use strict';
// const Parse = require('parse/node');

// const readonlyClass = '_Session';

// describe('ReadonlyTrigger tests', () => {
//   it('beforeSave should be read only', async () => {
//     Parse.Cloud.beforeSave(readonlyClass, function (req) {
//       req.object.set('KeyA', 'EDITED_VALUE');
//       req.object.set('KeyB', 'EDITED_VALUE');
//     });
//     const object = new Parse.Object(readonlyClass);
//     object.set('KeyA', 'ValueA');
//     object.set('KeyB', 'ValueB');
//     await object.save();
//     const query = new Parse.Query(readonlyClass);
//     query.equalTo('objectId', object.id);
//     const serverObject = await query.first({
//       useMasterKey: true
//     });
//     expect(serverObject.get('KeyA')).toBe('ValueA');
//     expect(serverObject.get('KeyB')).toBe('ValueB');
//   });
//   it('beforeSave should fail on throw', async () => {
//     Parse.Cloud.beforeSave(readonlyClass, function () {
//       throw new Parse.Error(12345678, 'Nop');
//     });
//     const object = new Parse.Object(readonlyClass);
//     object.set('KeyA', 'ValueA');
//     object.set('KeyB', 'ValueB');
//     try {
//       await object.save();
//       throw 'Should not have passed';
//     } catch (error) {
//       expect(error.code).toBe(12345678);
//       expect(error.message).toBe('Nop');
//     }
//   });
//   it('beforeDelete should ignore thrown error', async () => {
//     Parse.Cloud.beforeDelete(readonlyClass, function () {
//       throw new Parse.Error(12345678, 'Nop');
//     });
//     const object = new Parse.Object(readonlyClass);
//     object.set('KeyA', 'ValueA');
//     object.set('KeyB', 'ValueB');
//     await object.save();
//     try {
//       await object.destroy({}, {
//         useMasterKey: true
//       });
//     } catch (error) {
//       throw 'should have succeeded';
//     }
//   });
// });
