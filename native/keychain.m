// Node-API only: synchronous Security.framework calls inside the utility host.
// No enumeration, logging, process launch, global keychain state or UI prompts.
#define NAPI_VERSION 8
#include <node_api.h>
#include <Security/Security.h>
#include <string.h>
#import <LocalAuthentication/LocalAuthentication.h>
#ifdef F5_SYNTHETIC_SECURITY
#include "../src/migration-tests/fixtures/f5-native-security.h"
#endif

static napi_value fail(napi_env env) {
  napi_throw_error(env, NULL, "CREDENTIAL_UNAVAILABLE"); return NULL;
}
// Closed, non-sensitive categories for local package diagnostics. The host
// adapter still collapses every native failure to CREDENTIAL_UNAVAILABLE.
static napi_value fail_status(napi_env env, OSStatus status) {
  const char *code = "KEYCHAIN_OPERATION_DENIED";
  if (status == errSecMissingEntitlement) code = "KEYCHAIN_MISSING_ENTITLEMENT";
  else if (status == errSecInteractionNotAllowed) code = "KEYCHAIN_INTERACTION_DENIED";
  else if (status == errSecAuthFailed) code = "KEYCHAIN_AUTH_DENIED";
  napi_value message, error, reason;
  if (napi_create_string_utf8(env, "CREDENTIAL_UNAVAILABLE", NAPI_AUTO_LENGTH, &message) != napi_ok
      || napi_create_error(env, NULL, message, &error) != napi_ok
      || napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &reason) != napi_ok
      || napi_set_named_property(env, error, "code", reason) != napi_ok) return fail(env);
  napi_throw(env, error); return NULL;
}
static CFMutableDictionaryRef dict(void) {
  return CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}
static CFMutableDictionaryRef query(napi_env env, napi_value value) {
  char account[96]; size_t length = 0;
  if (napi_get_value_string_utf8(env, value, account, sizeof(account), &length) != napi_ok
      || length < 64 || length > 81) return NULL;
  for (size_t i = 0; i < length; i++) {
    if (i < 64) { if (!((account[i] >= '0' && account[i] <= '9') || (account[i] >= 'a' && account[i] <= 'f'))) return NULL; }
    else if (i == 64) { if (account[i] != ':') return NULL; }
    else if (account[i] < '0' || account[i] > '9') return NULL;
  }
  if (length == 65) return NULL;
  CFStringRef name = CFStringCreateWithBytes(NULL, (UInt8 *)account, length, kCFStringEncodingUTF8, false);
  if (!name) return NULL;
  CFMutableDictionaryRef q = dict();
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(q, kSecAttrService, CFSTR("com.orchestrion.local.credentials.v1"));
  CFDictionarySetValue(q, kSecAttrAccount, name);
  CFDictionarySetValue(q, kSecAttrSynchronizable, kCFBooleanFalse);
  CFDictionarySetValue(q, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  LAContext *context = [LAContext new];
  context.interactionNotAllowed = YES;
  if (!context.interactionNotAllowed) { CFRelease(name); CFRelease(q); return NULL; }
  CFDictionarySetValue(q, kSecUseAuthenticationContext, (__bridge CFTypeRef)context);
  CFRelease(name); return q;
}
static CFDataRef bytes(napi_env env, napi_value value, size_t min, size_t max) {
  bool is_buffer = false; void *data = NULL; size_t length = 0;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer
      || napi_get_buffer_info(env, value, &data, &length) != napi_ok || length < min || length > max) return NULL;
  // JS owns these bytes for this synchronous call; do not create an additional
  // plaintext input allocation whose lifetime escapes the service's Buffer wipe.
  return CFDataCreateWithBytesNoCopy(NULL, data, length, kCFAllocatorNull);
}
static napi_value read_item(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t count = 2;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 1) return fail(env);
  CFMutableDictionaryRef q = query(env, args[0]); if (!q) return fail(env);
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef data = NULL; OSStatus status = SecItemCopyMatching(q, &data); CFRelease(q);
  napi_value result;
  if (status == errSecItemNotFound) { napi_get_null(env, &result); return result; }
  if (status != errSecSuccess || !data) { if (data) CFRelease(data); return fail_status(env, status); }
  if (CFGetTypeID(data) != CFDataGetTypeID() || CFDataGetLength(data) < 32 || CFDataGetLength(data) > 65568) {
    CFRelease(data); return fail(env);
  }
  napi_status copied = napi_create_buffer_copy(env, CFDataGetLength(data), CFDataGetBytePtr(data), NULL, &result);
  CFRelease(data); return copied == napi_ok ? result : fail(env);
}
static napi_value exchange(napi_env env, napi_callback_info info) {
  napi_value args[4]; size_t count = 4; napi_valuetype type;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 3
      || napi_typeof(env, args[1], &type) != napi_ok) return fail(env);
  CFMutableDictionaryRef q = query(env, args[0]); if (!q) return fail(env);
  CFDataRef expected = type == napi_null ? NULL : bytes(env, args[1], 32, 32);
  CFDataRef value = bytes(env, args[2], 32, 65568);
  if ((!expected && type != napi_null) || !value) {
    if (expected) CFRelease(expected); if (value) CFRelease(value); CFRelease(q); return fail(env);
  }
  CFDataRef tag = CFDataCreate(NULL, CFDataGetBytePtr(value), 32);
  OSStatus status;
  if (!expected) {
    CFDictionarySetValue(q, kSecValueData, value);
    CFDictionarySetValue(q, kSecAttrGeneric, tag);
    CFDictionarySetValue(q, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
    status = SecItemAdd(q, NULL);
  } else {
    CFDictionarySetValue(q, kSecAttrGeneric, expected);
    CFMutableDictionaryRef changes = dict();
    CFDictionarySetValue(changes, kSecValueData, value);
    CFDictionarySetValue(changes, kSecAttrGeneric, tag);
    status = SecItemUpdate(q, changes); CFRelease(changes); CFRelease(expected);
  }
  CFRelease(tag); CFRelease(value); CFRelease(q);
  if (status != errSecSuccess) return fail_status(env, status);
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value remove_item(napi_env env, napi_callback_info info) {
  napi_value args[3]; size_t count = 3;
  if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2) return fail(env);
  CFMutableDictionaryRef q = query(env, args[0]); if (!q) return fail(env);
  CFDataRef tag = bytes(env, args[1], 32, 32);
  if (!tag) { CFRelease(q); return fail(env); }
  CFDictionarySetValue(q, kSecAttrGeneric, tag);
  OSStatus status = SecItemDelete(q); CFRelease(tag); CFRelease(q);
  if (status != errSecSuccess && status != errSecItemNotFound) return fail_status(env, status);
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"read", NULL, read_item, NULL, NULL, NULL, napi_default, NULL},
    {"compareExchange", NULL, exchange, NULL, NULL, NULL, napi_default, NULL},
    {"remove", NULL, remove_item, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) return fail(env);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
