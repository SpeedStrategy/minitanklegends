/* Runtime test for the account primitives. No framework, no mocking: real
   WebCrypto, real PBKDF2, real timing. Run with:
     node test-lib.mjs                                                        */
import {
  makeCredential, verifyPassword, timingSafeEqual, hashToken, randomToken, newId,
  validateUsername, validateEmail, validatePassword, mergeProfile, publicUser,
  clampIterations, hashPassword, toHex, PBKDF2_ITERATIONS,
} from './lib-auth.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`); }
};

console.log('\n-- timingSafeEqual --');
ok('equal strings match', timingSafeEqual('abc123', 'abc123'));
ok('different strings differ', !timingSafeEqual('abc123', 'abc124'));
ok('different lengths differ', !timingSafeEqual('abc', 'abcd'));
ok('empty vs value differs', !timingSafeEqual('', 'a'));
ok('null input is safe', !timingSafeEqual(null, 'a'));
ok('undefined input is safe', !timingSafeEqual(undefined, undefined));

console.log('\n-- validateUsername --');
ok('accepts normal name', validateUsername('Nojus').ok);
ok('accepts underscores/dashes', validateUsername('a_b-c9').ok);
ok('rejects too short', !validateUsername('ab').ok);
ok('rejects too long', !validateUsername('a'.repeat(21)).ok);
ok('rejects spaces', !validateUsername('no jus').ok);
ok('rejects empty', !validateUsername('').ok);
ok('rejects null', !validateUsername(null).ok);
ok('trims whitespace', validateUsername('  bob  ').value === 'bob');

console.log('\n-- validateEmail --');
ok('accepts normal', validateEmail('A@B.com').value === 'a@b.com');
ok('rejects no-at', !validateEmail('nope').ok);
ok('rejects empty', !validateEmail('').ok);
ok('rejects over-long', !validateEmail('a'.repeat(250) + '@b.com').ok);

console.log('\n-- validatePassword --');
ok('accepts 8 chars', validatePassword('12345678').ok);
ok('rejects 7 chars', !validatePassword('1234567').ok);
ok('rejects non-string', !validatePassword(12345678).ok);
ok('rejects over-long', !validatePassword('a'.repeat(257)).ok);

console.log('\n-- clampIterations --');
ok('policy value passes through', clampIterations(PBKDF2_ITERATIONS) === PBKDF2_ITERATIONS);
ok('too-low falls back to policy', clampIterations(5) === PBKDF2_ITERATIONS);
ok('too-high is capped', clampIterations(999999999) === 1000000);
ok('NaN falls back to policy', clampIterations('abc') === PBKDF2_ITERATIONS);
ok('negative falls back to policy', clampIterations(-1) === PBKDF2_ITERATIONS);

console.log('\n-- password hashing --');
const cred = await makeCredential('correct horse battery');
ok('salt is 32 hex chars', cred.salt.length === 32);
ok('hash is 64 hex chars', cred.hash.length === 64);
ok('iterations recorded', cred.iterations === PBKDF2_ITERATIONS);

const row = { password_salt: cred.salt, password_hash: cred.hash, iterations: cred.iterations };
const good = await verifyPassword('correct horse battery', row);
ok('correct password verifies', good.ok === true);
ok('no rehash needed at current policy', good.needsRehash === false);

const bad = await verifyPassword('wrong password', row);
ok('wrong password rejected', bad.ok === false);

ok('same input gives same hash', (await (async () => {
  const a = await makeCredential('repeatable');
  const b = await makeCredential('repeatable');
  return a.hash !== b.hash; // different salts => different hashes
})()), 'different salts produce different hashes');

console.log('\n-- rehash-on-login --');
/* A genuinely OLD credential: hashed with a LOWER round count, the way a row
   written before the work factor was raised would be. Reusing the current
   credential's hash here while relabelling its iterations would test nothing. */
const oldSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
const oldHash = await hashPassword('correct horse battery', oldSalt, 10000);
const old = { password_salt: oldSalt, password_hash: oldHash, iterations: 10000 };
const oldCheck = await verifyPassword('correct horse battery', old);
ok('old-iteration hash still verifies', oldCheck.ok === true, 'stored hash was made at 10k rounds');
ok('flags that a rehash is due', oldCheck.needsRehash === true);
ok('wrong password fails on an old row too',
   (await verifyPassword('nope', old)).ok === false);

console.log('\n-- token hashing --');
const t1 = randomToken(32), t2 = randomToken(32);
ok('tokens are 32 chars', t1.length === 32);
ok('two tokens differ', t1 !== t2);
const h1 = await hashToken(t1);
ok('hash is 64 hex chars', h1.length === 64);
ok('hashing is deterministic', (await hashToken(t1)) === h1);
ok('different tokens hash differently', (await hashToken(t2)) !== h1);
ok('token is not its own hash', t1 !== h1);
const id = newId();
ok('id looks like a uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));

console.log('\n-- mergeProfile --');
const prev = { cash: 100, coins: 5, gold: 10, unlockedTanks: ['coolbuddy'], playerName: 'Old' };
const next = { cash: 100, coins: 9, unlockedTanks: ['panzer'], selectedTank: 'panzer' };
const merged = mergeProfile(prev, next);
ok('currency takes the max', merged.cash === 100 && merged.coins === 9);
ok('tanks are unioned', merged.unlockedTanks.length === 2 && merged.unlockedTanks.includes('panzer'));
ok('a stale client cannot lower gold', merged.gold === 10);
ok('new tank selection wins', merged.selectedTank === 'panzer');
ok('omitted name is preserved', merged.playerName === 'Old');

const legacy = mergeProfile({ coins: 500 }, {});
ok('legacy lone-coin profile is read as cash', legacy.cash === 500);
ok('legacy coin is not double-counted as coins', legacy.coins === 0);

const gems = mergeProfile({ gems: 7 }, {});
ok('renamed gems become gold', gems.gold === 7);
ok('legacy gems do not double with gold', mergeProfile({ gems: 7, gold: 3 }, {}).gold === 3);

ok('empty inputs do not throw', typeof mergeProfile(undefined, undefined) === 'object');
ok('always has a starting tank', mergeProfile({}, {}).unlockedTanks.includes('coolbuddy'));

console.log('\n-- publicUser --');
const userRow = {
  id: 'abc', username: 'Nojus', email: 'a@b.c',
  email_verified_at: null, created_at: 1700000000, profile: '{"cash":5}',
  password_hash: 'SECRET', password_salt: 'ALSOSECRET',
};
const pub = publicUser(userRow);
ok('never leaks password hash', !('password_hash' in pub));
ok('never leaks salt', !('password_salt' in pub));
ok('exposes username', pub.username === 'Nojus');
ok('parses profile json', pub.profile.cash === 5);
ok('unverified reads false', pub.emailVerified === false);
ok('bad profile json does not throw', publicUser({ ...userRow, profile: 'not json' }).profile && true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);