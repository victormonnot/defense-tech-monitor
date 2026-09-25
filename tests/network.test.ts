import assert from "node:assert/strict";
import test from "node:test";
import { isPublicAddress, validateRemoteUrl } from "../src/lib/network";

test("address checks reject private, loopback, reserved and mapped private addresses", () => {
  const rejected = [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.2.3.4",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.2.3",
    "::ffff:c0a8:101",
    "not-an-address",
  ];
  for (const address of rejected)
    assert.equal(isPublicAddress(address), false, address);
});

test("address checks accept public IPv4, IPv6 and mapped public addresses", () => {
  for (const address of [
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ]) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("source URLs reject local hosts and normalized private IP literals", () => {
  const rejected = [
    "http://localhost/feed",
    "http://news.localhost/feed",
    "https://printer.local/feed",
    "http://127.0.0.1/feed",
    "http://127.1/feed",
    "http://2130706433/feed",
    "http://0x7f000001/feed",
    "http://0177.0.0.1/feed",
    "https://10.0.0.1/feed",
    "https://172.16.0.1/feed",
    "https://192.168.1.1/feed",
    "http://169.254.169.254/",
    "http://[::1]/feed",
    "http://[fd00::1]/feed",
    "http://[fe80::1]/feed",
    "http://[::ffff:127.0.0.1]/feed",
    "http://[::ffff:c0a8:101]/feed",
  ];
  for (const url of rejected)
    assert.throws(() => validateRemoteUrl(url), /locales ou privées/, url);
});

test("source URLs require HTTP(S), no credentials, and standard ports", () => {
  for (const url of [
    "file:///etc/passwd",
    "ftp://example.com/feed",
    "javascript:alert(1)",
    "data:text/xml,feed",
    "https://user@example.com/feed",
    "https://user:password@example.com/feed",
  ])
    assert.throws(
      () => validateRemoteUrl(url),
      /HTTP\(S\) sans identifiants/,
      url,
    );

  for (const url of [
    "http://example.com:3000/feed",
    "https://example.com:8443/feed",
  ]) {
    assert.throws(
      () => validateRemoteUrl(url),
      /ports HTTP et HTTPS standards/,
      url,
    );
  }
});

test("public URLs preserve their path and query while removing fragments", () => {
  assert.equal(
    validateRemoteUrl("https://example.com:443/news/feed?language=en#latest")
      .href,
    "https://example.com/news/feed?language=en",
  );
  assert.equal(
    validateRemoteUrl("http://example.com:80/feed").href,
    "http://example.com/feed",
  );
  assert.equal(validateRemoteUrl("https://1.1.1.1/feed").hostname, "1.1.1.1");
  assert.equal(
    validateRemoteUrl("https://[2606:4700:4700::1111]/feed").hostname,
    "[2606:4700:4700::1111]",
  );
});
