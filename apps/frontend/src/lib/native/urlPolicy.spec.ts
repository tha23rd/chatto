import { describe, expect, it } from 'vitest';
import {
  assertAllowedHttpEndpoint,
  assertAllowedRealtimeUrl,
  assertAllowedServerUrl
} from './urlPolicy';

describe('native server URL policy', () => {
  it.each([
    ['https://chat.example.com', 'https://chat.example.com'],
    ['https://chat.example.com:8443/', 'https://chat.example.com:8443'],
    ['http://localhost:4000', 'http://localhost:4000'],
    ['http://127.0.0.1:4000/', 'http://127.0.0.1:4000'],
    ['http://[::1]:4000', 'http://[::1]:4000']
  ])('accepts server base %s', (input, expected) => {
    expect(assertAllowedServerUrl(input)).toBe(expected);
  });

  it.each([
    'http://chat.example.com',
    'http://192.168.1.20:4000',
    'ftp://chat.example.com',
    'https://user:secret@chat.example.com',
    'https://chat.example.com/base',
    'https://chat.example.com?token=secret',
    'https://chat.example.com/#fragment',
    'not a URL'
  ])('rejects unsafe server base %s without echoing it', (input) => {
    expect(() => assertAllowedServerUrl(input)).toThrow('Server URL is not allowed');
    try {
      assertAllowedServerUrl(input);
    } catch (error) {
      expect(String(error)).not.toContain('token=secret');
      expect(String(error)).not.toContain('user:secret');
    }
  });

  it('allows HTTPS and loopback HTTP API endpoints', () => {
    expect(assertAllowedHttpEndpoint('https://chat.example.com/api/connect?debug=1')).toBe(
      'https://chat.example.com/api/connect?debug=1'
    );
    expect(assertAllowedHttpEndpoint('http://localhost:4000/api/connect')).toBe(
      'http://localhost:4000/api/connect'
    );
  });

  it.each([
    ['wss://chat.example.com/api/realtime', 'wss://chat.example.com/api/realtime'],
    ['ws://127.0.0.1:4000/api/realtime', 'ws://127.0.0.1:4000/api/realtime'],
    ['ws://[::1]:4000/api/realtime', 'ws://[::1]:4000/api/realtime']
  ])('accepts realtime URL %s', (input, expected) => {
    expect(assertAllowedRealtimeUrl(input)).toBe(expected);
  });

  it.each([
    'ws://chat.example.com/api/realtime',
    'ws://192.168.1.20:4000/api/realtime',
    'https://chat.example.com/api/realtime',
    'wss://user:secret@chat.example.com/api/realtime',
    'wss://chat.example.com/api/realtime#fragment'
  ])('rejects unsafe realtime URL %s', (input) => {
    expect(() => assertAllowedRealtimeUrl(input)).toThrow('Realtime URL is not allowed');
  });
});
