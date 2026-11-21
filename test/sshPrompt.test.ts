import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPasswordPrompt } from '../src/main/sshTunnel';

test('recognises the many ways bastions ask for the password', () => {
  for (const p of [
    'Password: ', 'password:', 'Password for ops@bastion.example.com: ', '(ops@bastion) Password: ',
    'ops@10.0.0.1\'s password: ', 'Enter passphrase: ', 'Enter your password:', 'LDAP Password: ', 'Passwd:',
  ]) assert.equal(isPasswordPrompt(p, false), true, p);
});

test('one-time codes are left to the user', () => {
  for (const p of [
    'Verification code: ', 'OTP: ', 'Enter your one-time code: ', 'Authenticator code:', 'Token: ', 'Duo two-factor login (1-3)? ',
    'Please enter the 6 digit code:', 'TOTP: ', 'MFA code: ',
  ]) assert.equal(isPasswordPrompt(p, false), false, p);
});

test('visible (echo) prompts that are not about a password are not auto-answered', () => {
  assert.equal(isPasswordPrompt('Username: ', true), false);
  assert.equal(isPasswordPrompt('Select option [1-3]: ', true), false);
});
