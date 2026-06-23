// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Marrow wordmark + dot, used in the sidebar and on the splash/onboarding
 * screens. Extracted so the markup lives in exactly one place.
 */

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-dot" />
      Marrow
    </div>
  );
}
