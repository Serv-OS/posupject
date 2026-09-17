import { describe, it, expect } from 'vitest';
import { reconnectDelay, needsFreshToken, watchdogAction, wasMissed } from './phoneRing.js';

describe('reconnectDelay', () => {
  it('backs off 1s, 2s, 5s, 10s and then holds at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay)).toEqual([1000, 2000, 5000, 10000, 30000, 30000, 30000]);
  });
  it('treats junk as the first attempt', () => {
    expect(reconnectDelay(undefined)).toBe(1000);
    expect(reconnectDelay(-3)).toBe(1000);
  });
});

describe('needsFreshToken', () => {
  it('spots the expired and invalid token errors', () => {
    expect(needsFreshToken({ code: 20104 })).toBe(true);
    expect(needsFreshToken({ code: 20101 })).toBe(true);
    expect(needsFreshToken({ code: 31205 })).toBe(true);
  });
  it('leaves other errors alone', () => {
    expect(needsFreshToken({ code: 31005 })).toBe(false);
    expect(needsFreshToken(null)).toBe(false);
  });
});

describe('watchdogAction', () => {
  it('does nothing when the user chose to be offline', () => {
    expect(watchdogAction({ wantOnline: false, deviceState: 'unregistered' })).toBe('idle');
  });
  it('beats while registered', () => {
    expect(watchdogAction({ wantOnline: true, deviceState: 'registered', gapMs: 30000 })).toBe('beat');
  });
  it('reconnects when the device dropped its registration', () => {
    expect(watchdogAction({ wantOnline: true, deviceState: 'unregistered' })).toBe('reconnect');
    expect(watchdogAction({ wantOnline: true, deviceState: undefined })).toBe('reconnect');
  });
  it('checks the connection after the laptop slept, even if the SDK still says registered', () => {
    expect(watchdogAction({ wantOnline: true, deviceState: 'registered', gapMs: 10 * 60000 })).toBe('reconnect');
  });
  it('never tears the phone down in the middle of a call', () => {
    expect(watchdogAction({ wantOnline: true, deviceState: 'unregistered', onCall: true, gapMs: 10 * 60000 })).toBe('beat');
  });
});

describe('wasMissed', () => {
  it('is missed when nobody picked it up', () => {
    expect(wasMissed({ answeredElsewhere: false, answeredHere: false, rejectedHere: false })).toBe(true);
  });
  it('is not missed when a colleague answered, or it was answered or declined here', () => {
    expect(wasMissed({ answeredElsewhere: true })).toBe(false);
    expect(wasMissed({ answeredHere: true })).toBe(false);
    expect(wasMissed({ rejectedHere: true })).toBe(false);
  });
});
