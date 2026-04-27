import { describe, expect, it } from 'bun:test'
import { parseConnectTarget } from '../../src/sandbox/http-proxy.js'

describe('parseConnectTarget', () => {
  it('parses the standard node CONNECT target', () => {
    expect(
      parseConnectTarget({
        url: 'example.com:443',
        headers: {},
      }),
    ).toEqual({
      hostname: 'example.com',
      port: 443,
    })
  })

  it('parses a bun-style absolute url CONNECT target', () => {
    expect(
      parseConnectTarget({
        url: 'http://example.com:443',
        headers: {},
      }),
    ).toEqual({
      hostname: 'example.com',
      port: 443,
    })
  })

  it('falls back to the host header when url is unusable', () => {
    expect(
      parseConnectTarget({
        url: '/',
        headers: {
          host: 'example.com:443',
        },
      }),
    ).toEqual({
      hostname: 'example.com',
      port: 443,
    })
  })

  it('rejects malformed CONNECT targets', () => {
    expect(
      parseConnectTarget({
        url: 'not a target',
        headers: {},
      }),
    ).toBeNull()
  })
})
