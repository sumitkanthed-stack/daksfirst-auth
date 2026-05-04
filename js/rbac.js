/**
 * js/rbac.js
 *
 * Frontend permission helper. Mirrors middleware/rbac.js role-sets.
 * Single source of truth lives on the backend; this file is for instant
 * client-side render decisions.
 *
 * USAGE:
 *   import { RBAC } from './rbac.js';
 *   if (RBAC.canSeeRiskGradePill()) renderPill();
 *
 * data-roles attribute: any element with data-roles="admin,rm,credit" will
 * be auto-hidden by RBAC.applyDataRoles() if the current user's role isn't
 * in the comma-list. Idempotent — safe to call repeatedly.
 *
 * NOT a security boundary — every API call is server-gated. This file is
 * pure UX.
 */

import { getCurrentRole } from './state.js';

const ROLE_SETS = {
  ALL_INTERNAL:        ['admin', 'rm', 'credit', 'compliance'],
  PRICING_READ:        ['admin', 'rm', 'credit'],
  PRICING_WRITE:       ['admin'],
  LLM_CONFIG:          ['admin'],
  RISK_TAXONOMY:       ['admin'],
  KYC_AML_REVIEW:      ['admin', 'rm', 'credit', 'compliance'],
  SANCTIONS_PEP:       ['admin', 'credit', 'compliance'],
  AUDIT_LOG_READ:      ['admin', 'compliance'],
  BROKER_TIER_MGMT:    ['admin'],
  USER_CRUD:           ['admin'],
  PAID_API_PULL:       ['admin', 'rm', 'credit'],
  KYC_PRODUCT_PULL:    ['admin', 'rm', 'credit', 'compliance'],
  INTERNAL_NOTES:      ['admin', 'rm', 'credit', 'compliance'],
  DEAL_ANY_EDIT:       ['admin', 'credit'],
  DEAL_ASSIGNED_EDIT:  ['admin', 'rm', 'credit']
};

function role() {
  try { return (getCurrentRole && getCurrentRole()) || 'broker'; }
  catch (e) { return 'broker'; }
}

function inSet(set) { return set.includes(role()); }

export const RBAC = {
  role,
  isAdmin:        () => role() === 'admin',
  isCredit:       () => role() === 'credit',
  isRM:           () => role() === 'rm',
  isCompliance:   () => role() === 'compliance',
  isBroker:       () => role() === 'broker',
  isBorrower:     () => role() === 'borrower',
  isInternal:     () => inSet(ROLE_SETS.ALL_INTERNAL),

  canReadPricingConfig:  () => inSet(ROLE_SETS.PRICING_READ),
  canEditPricingConfig:  () => inSet(ROLE_SETS.PRICING_WRITE),
  canReadLLMConfig:      () => inSet(ROLE_SETS.LLM_CONFIG),
  canSeeRiskGradePill:   () => inSet(ROLE_SETS.ALL_INTERNAL),
  canSeeInternalNotes:   () => inSet(ROLE_SETS.INTERNAL_NOTES),
  canPullPaidAPIs:       () => inSet(ROLE_SETS.PAID_API_PULL),
  canPullKYCProducts:    () => inSet(ROLE_SETS.KYC_PRODUCT_PULL),
  canReviewKYC:          () => inSet(ROLE_SETS.KYC_AML_REVIEW),
  canReviewSanctions:    () => inSet(ROLE_SETS.SANCTIONS_PEP),
  canReadAuditLog:       () => inSet(ROLE_SETS.AUDIT_LOG_READ),
  canManageBrokerTiers:  () => inSet(ROLE_SETS.BROKER_TIER_MGMT),
  canCRUDUsers:          () => inSet(ROLE_SETS.USER_CRUD),
  canEditAnyDeal:        () => inSet(ROLE_SETS.DEAL_ANY_EDIT),

  /**
   * Walks every [data-roles] element in the document and hides those whose
   * role-list excludes the current user. Idempotent.
   *   data-roles="admin,rm,credit" — visible to admin/rm/credit only
   *   No data-roles attribute — element untouched
   */
  applyDataRoles() {
    const r = role();
    const els = document.querySelectorAll('[data-roles]');
    for (const el of els) {
      const allowed = (el.getAttribute('data-roles') || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length === 0) continue;
      if (allowed.includes(r)) {
        if (el.hasAttribute('data-roles-hidden')) {
          el.removeAttribute('data-roles-hidden');
          el.style.display = el.getAttribute('data-roles-orig-display') || '';
          el.removeAttribute('data-roles-orig-display');
        }
      } else {
        if (!el.hasAttribute('data-roles-hidden')) {
          el.setAttribute('data-roles-orig-display', el.style.display || '');
          el.setAttribute('data-roles-hidden', '1');
        }
        el.style.display = 'none';
      }
    }
  }
};

// Convenience: expose globally for inline onclick handlers + console debugging.
if (typeof window !== 'undefined') window.RBAC = RBAC;