import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firewallBanReportSchema,
  normalizePublicIpAddress,
} from "../src/products/panel/modules/firewall/firewall.service.js";

test("global firewall accepts and normalizes public addresses", () => {
  assert.equal(normalizePublicIpAddress(" 8.8.8.8 "), "8.8.8.8");
  assert.equal(
    normalizePublicIpAddress("2606:4700:4700:0:0:0:0:1111"),
    "2606:4700:4700::1111",
  );
  assert.equal(
    firewallBanReportSchema.safeParse({ ipAddress: "1.1.1.1", jail: "sshd" })
      .success,
    true,
  );
});

test("global firewall rejects private, loopback, documentation, and malformed addresses", () => {
  for (const ipAddress of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "203.0.113.10",
    "::1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "not-an-ip",
  ]) {
    assert.equal(normalizePublicIpAddress(ipAddress), null, ipAddress);
  }
});

test("Fail2Ban jail names cannot inject commands or configuration", () => {
  assert.equal(
    firewallBanReportSchema.safeParse({
      ipAddress: "8.8.4.4",
      jail: "sshd; touch /tmp/injected",
    }).success,
    false,
  );
});
