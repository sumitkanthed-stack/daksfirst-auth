/**
 * Main app entry point - imports all modules and initializes the application
 */

import { showScreen } from './utils.js';
import { initAuthAndRouting, logoutUser, loginUser, registerUser, handleEmailVerification } from './auth.js';
import { showDealForm, submitDeal, switchDealTab, dealTabNext, dealTabBack, showDashboard } from './deals.js';
import { showAdminPanel, switchAdminTab, updateAdminDealsFilter, loadAdminUsers } from './admin.js';
import { switchDetailTab, saveOnboardingTab } from './onboarding.js';
import { handleSmartDrop, handleSmartFileSelect, toggleWhatsappPaste, handleWhatsappSubmit, confirmSmartParse, cancelSmartParse, toggleExistingDealSelect } from './smart-parse.js';
import { handleDocumentDragOver, handleDocumentDragLeave, handleDocumentDrop, handleFileSelect, downloadDocumentById, viewDocumentInline } from './documents.js';
import { showToast } from './utils.js';

// Expose global functions to window for inline onclick handlers
window.showScreen = showScreen;
window.showToast = showToast;
window.showDealForm = showDealForm;
window.submitDeal = submitDeal;
window.switchDealTab = switchDealTab;
window.dealTabNext = dealTabNext;
window.dealTabBack = dealTabBack;
window.showDashboard = showDashboard;
window.showAdminPanel = showAdminPanel;
window.switchAdminTab = switchAdminTab;
window.updateAdminDealsFilter = updateAdminDealsFilter;
window.loadAdminUsers = loadAdminUsers;
window.switchDetailTab = switchDetailTab;
window.saveOnboardingTab = saveOnboardingTab;
window.logoutUser = logoutUser;
window.loginUser = loginUser;
window.registerUser = registerUser;
window.handleSmartDrop = handleSmartDrop;
window.handleSmartFileSelect = handleSmartFileSelect;
window.toggleWhatsappPaste = toggleWhatsappPaste;
window.handleWhatsappSubmit = handleWhatsappSubmit;
window.confirmSmartParse = confirmSmartParse;
window.cancelSmartParse = cancelSmartParse;
window.toggleExistingDealSelect = toggleExistingDealSelect;
window.handleDocumentDragOver = handleDocumentDragOver;
window.handleDocumentDragLeave = handleDocumentDragLeave;
window.handleDocumentDrop = handleDocumentDrop;
window.handleFileSelect = handleFileSelect;
window.downloadDocumentById = downloadDocumentById;
window.viewDocumentInline = viewDocumentInline;
window.handleEmailVerification = handleEmailVerification;

// Lazy-load workflow and DIP functions when needed
window.assignRM = () => import('./workflow-actions.js').then(m => m.assignRM());
window.assignRMAndAdvance = () => import('./workflow-actions.js').then(m => m.assignRMAndAdvance());
window.assignReviewer = (type) => import('./workflow-actions.js').then(m => m.assignReviewer(type));
window.advanceStage = (newStage) => import('./workflow-actions.js').then(m => m.advanceStage(newStage));
window.confirmFee = () => import('./workflow-actions.js').then(m => m.confirmFee());
window.submitRecommendation = (decision) => import('./workflow-actions.js').then(m => m.submitRecommendation(decision));
window.acceptDipExternal = () => import('./workflow-actions.js').then(m => m.acceptDipExternal());
window.acceptDealExternal = () => import('./workflow-actions.js').then(m => m.acceptDealExternal());
window.submitToBank = () => import('./workflow-actions.js').then(m => m.submitToBank());
window.recordBankApproval = () => import('./workflow-actions.js').then(m => m.recordBankApproval());
window.recordBorrowerAcceptance = () => import('./workflow-actions.js').then(m => m.recordBorrowerAcceptance());
window.instructLegal = () => import('./workflow-actions.js').then(m => m.instructLegal());
window.completeDeal = () => import('./workflow-actions.js').then(m => m.completeDeal());
window.declineDeal = () => import('./workflow-actions.js').then(m => m.declineDeal());
window.withdrawDeal = () => import('./workflow-actions.js').then(m => m.withdrawDeal());
window.advanceStageSimple = (newStage) => import('./workflow-actions.js').then(m => m.advanceStageSimple(newStage));

window.removeDipProperty = (idx) => import('./dip.js').then(m => m.removeDipProperty(idx));
window.calcDipLtv = () => import('./dip.js').then(m => m.calcDipLtv());
window.issueDip = () => import('./dip.js').then(m => m.issueDip());
window.creditDecision = (decision) => import('./dip.js').then(m => m.creditDecision(decision));
window.generateAiTermsheet = () => import('./dip.js').then(m => m.generateAiTermsheet());
window.requestFee = () => import('./dip.js').then(m => m.requestFee());
window.confirmFeeAndAdvance = () => import('./dip.js').then(m => m.confirmFeeAndAdvance());

/**
 * Wrap traditional form submission handlers
 */
window.startRegistration = async function(role) {
  const firstNameEl = document.getElementById('reg-firstname');
  const lastNameEl = document.getElementById('reg-lastname');
  const emailEl = document.getElementById('reg-email');
  const passwordEl = document.getElementById('reg-password');
  const phoneEl = document.getElementById('reg-phone');
  const companyEl = document.getElementById('reg-company');

  const formData = {
    firstName: firstNameEl?.value.trim(),
    lastName: lastNameEl?.value.trim(),
    email: emailEl?.value.trim(),
    password: passwordEl?.value.trim(),
    phone: phoneEl?.value.trim(),
    company: companyEl?.value.trim()
  };

  if (!formData.email || !formData.password || !formData.firstName || !formData.lastName) {
    showToast('Please fill in required fields', true);
    return;
  }

  // Show loading state
  const regBtn = document.querySelector('button[onclick*="startRegistration"]');
  if (regBtn) {
    regBtn.disabled = true;
    regBtn.innerHTML = '<span class="spinner"></span> Registering...';
  }

  const success = await registerUser(role, formData);

  if (regBtn) {
    regBtn.disabled = false;
    regBtn.innerHTML = 'Register \u2192';
  }

  if (success) {
    showScreen('screen-reg-success');
  }
};

window.doLogin = async function() {
  const emailEl = document.getElementById('login-email');
  const passwordEl = document.getElementById('login-password');

  const email = emailEl?.value.trim();
  const password = passwordEl?.value.trim();

  if (!email || !password) {
    showToast('Please enter email and password', true);
    return;
  }

  const loginBtn = document.querySelector('button[onclick*="doLogin"]');
  if (loginBtn) {
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner"></span> Logging in...';
  }

  const success = await loginUser(email, password);

  if (loginBtn) {
    loginBtn.disabled = false;
    loginBtn.innerHTML = 'Login \u2192';
  }

  if (success) {
    const internalRoles = ['admin', 'rm', 'credit', 'compliance'];
    const currentRole = localStorage.getItem('daksfirst_role') || '';
    if (internalRoles.includes(currentRole)) {
      showAdminPanel();
    } else {
      showDashboard();
    }
  }
};

window.startLogin = function() {
  showScreen('screen-login');
};

window.goToRegister = function(role) {
  window.selectedRole = role;
  // Show registration form
  const firstPanel = document.getElementById('form-panel-0');
  if (firstPanel) {
    firstPanel.classList.remove('active');
    const nextPanel = document.getElementById('form-panel-1');
    if (nextPanel) nextPanel.classList.add('active');
  }
  showScreen('screen-register');
};

window.showRoleSelection = function() {
  showScreen('screen-landing');
};

window.createInternalUser = () => import('./admin.js').then(m => m.createInternalUser?.());

/**
 * Initialize the app on page load
 */
document.addEventListener('DOMContentLoaded', function() {
  // Initialize auth and routing
  initAuthAndRouting();

  // Add drag-drop listeners for documents if element exists
  const uploadZone = document.getElementById('upload-zone');
  if (uploadZone) {
    uploadZone.addEventListener('dragover', handleDocumentDragOver);
    uploadZone.addEventListener('dragleave', handleDocumentDragLeave);
    uploadZone.addEventListener('drop', handleDocumentDrop);
  }

  // Add drag-drop listeners for smart-parse if element exists
  const smartZone = document.getElementById('smart-drop-zone');
  if (smartZone) {
    smartZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      smartZone.classList.add('active');
    });
    smartZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      smartZone.classList.remove('active');
    });
    smartZone.addEventListener('drop', handleSmartDrop);
  }

  // Set up file inputs
  const docInput = document.getElementById('document-file-input');
  if (docInput) {
    docInput.addEventListener('change', handleFileSelect);
  }

  const smartInput = document.getElementById('smart-file-input');
  if (smartInput) {
    smartInput.addEventListener('change', handleSmartFileSelect);
  }

  console.log('Daksfirst Portal initialized');
});
