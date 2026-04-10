/**
 * Main app entry point - imports all modules and initializes the application
 */

import { showScreen } from './utils.js';
import { initAuthAndRouting, logoutUser, loginUser, registerUser, handleEmailVerification } from './auth.js';
import { showDealForm, submitDeal, switchDealTab, dealTabNext, dealTabBack, showDashboard } from './deals.js';
import { showAdminPanel, switchAdminTab, updateAdminDealsFilter, loadAdminUsers } from './admin.js';
import { switchDetailTab, saveOnboardingTab, toggleBrokerCompanyFields, loadBrokerOnboarding, showBrokerOnboarding, hideBrokerOnboarding, saveBrokerOnboarding } from './onboarding.js';
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
window.loadBrokerOnboarding = loadBrokerOnboarding;
window.showBrokerOnboarding = showBrokerOnboarding;
window.hideBrokerOnboarding = hideBrokerOnboarding;
window.saveBrokerOnboarding = saveBrokerOnboarding;
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
window.addBorrower = () => import('./workflow-actions.js').then(m => m.addBorrower());
window.removeBorrower = (id) => import('./workflow-actions.js').then(m => m.removeBorrower(id));
window.addProperty = () => import('./workflow-actions.js').then(m => m.addProperty());
window.removeProperty = (id) => import('./workflow-actions.js').then(m => m.removeProperty(id));
window.loadLawFirms = () => import('./workflow-actions.js').then(m => m.loadLawFirms());
window.selectLawFirm = (firm, email, contact) => import('./workflow-actions.js').then(m => m.selectLawFirm(firm, email, contact));
window.saveIntakeChanges = () => import('./workflow-actions.js').then(m => m.saveIntakeChanges());

window.removeDipProperty = (idx) => import('./dip.js').then(m => m.removeDipProperty(idx));
window.approveDipProperty = (idx) => import('./dip.js').then(m => m.approveDipProperty(idx));
window.addBackDipProperty = (idx) => import('./dip.js').then(m => m.addBackDipProperty(idx));
window.approveAllDipProperties = () => import('./dip.js').then(m => m.approveAllDipProperties());
window.calcDipLtv = () => import('./dip.js').then(m => m.calcDipLtv());
window.issueDip = () => import('./dip.js').then(m => m.issueDip());
window.creditDecision = (decision) => import('./dip.js').then(m => m.creditDecision(decision));
window.submitMoreInfo = () => import('./dip.js').then(m => m.submitMoreInfo());
window.respondToCreditQuery = () => import('./dip.js').then(m => m.respondToCreditQuery());
window.generateAiTermsheet = () => import('./dip.js').then(m => m.generateAiTermsheet());
window.acceptDip = (submissionId) => import('./dip.js').then(m => m.acceptDip(submissionId));
window.viewDipPdf = (submissionId) => import('./dip.js').then(m => m.viewDipPdf(submissionId));
window.requestFee = () => import('./dip.js').then(m => m.requestFee());
window.confirmFeeAndAdvance = () => import('./dip.js').then(m => m.confirmFeeAndAdvance());
window.updateFees = () => import('./dip.js').then(m => m.updateFees());

/**
 * Wrap traditional form submission handlers
 */
window.startRegistration = async function(role) {
  const firstNameEl = document.getElementById('first-name');
  const lastNameEl = document.getElementById('last-name');
  const emailEl = document.getElementById('email');
  const passwordEl = document.getElementById('password');
  const phoneEl = document.getElementById('phone');
  const companyEl = document.getElementById('company');

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
    const { getCurrentRole } = await import('./state.js');
    const role = getCurrentRole();
    if (internalRoles.includes(role)) {
      showAdminPanel();
    } else {
      showDashboard();
    }
  }
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
