/**
 * Shared application state management
 * All state is stored here and exported via getter/setter functions
 */

let authToken = null;
let refreshToken = null;
let currentUser = null;
let currentRole = '';
let currentDealData = null;
let allAdminDeals = [];
let dipRemovedProperties = [];
let smartParsedData = null;
let smartParseSessionId = null;

// Getters
export function getAuthToken() {
  return authToken;
}

export function getRefreshToken() {
  return refreshToken;
}

export function getCurrentUser() {
  return currentUser;
}

export function getCurrentRole() {
  return currentRole;
}

export function getCurrentDealData() {
  return currentDealData;
}

export function getAllAdminDeals() {
  return allAdminDeals;
}

export function getDipRemovedProperties() {
  return dipRemovedProperties;
}

export function getSmartParsedData() {
  return smartParsedData;
}

export function getSmartParseSessionId() {
  return smartParseSessionId;
}

// Setters
export function setAuthToken(token) {
  authToken = token;
  if (token) {
    sessionStorage.setItem('daksfirst_token', token);
  } else {
    sessionStorage.removeItem('daksfirst_token');
  }
}

export function setRefreshToken(token) {
  refreshToken = token;
  if (token) {
    sessionStorage.setItem('daksfirst_refresh_token', token);
  } else {
    sessionStorage.removeItem('daksfirst_refresh_token');
  }
}

export function setCurrentUser(user) {
  currentUser = user;
  if (user) {
    sessionStorage.setItem('daksfirst_user', JSON.stringify(user));
  } else {
    sessionStorage.removeItem('daksfirst_user');
  }
}

export function setCurrentRole(role) {
  currentRole = role;
}

export function setCurrentDealData(data) {
  currentDealData = data;
}

export function setAllAdminDeals(deals) {
  allAdminDeals = deals;
}

export function setDipRemovedProperties(properties) {
  dipRemovedProperties = properties;
}

export function addDipRemovedProperty(prop) {
  dipRemovedProperties.push(prop);
}

export function removeDipRemovedProperty(idx) {
  dipRemovedProperties.splice(idx, 1);
}

export function clearDipRemovedProperties() {
  dipRemovedProperties = [];
}

export function setSmartParsedData(data) {
  smartParsedData = data;
}

export function setSmartParseSessionId(id) {
  smartParseSessionId = id;
}

/**
 * Restore session from storage on page load
 */
export function restoreSessionFromStorage() {
  const token = sessionStorage.getItem('daksfirst_token');
  const refreshTok = sessionStorage.getItem('daksfirst_refresh_token');
  const userStr = sessionStorage.getItem('daksfirst_user');

  if (token) {
    setAuthToken(token);
  }
  if (refreshTok) {
    setRefreshToken(refreshTok);
  }
  if (userStr) {
    try {
      const user = JSON.parse(userStr);
      setCurrentUser(user);
      setCurrentRole(user.role);
      return true;
    } catch (e) {
      clearSession();
      return false;
    }
  }
  return false;
}

/**
 * Clear all session data
 */
export function clearSession() {
  setAuthToken(null);
  setRefreshToken(null);
  setCurrentUser(null);
  setCurrentRole('');
  setCurrentDealData(null);
  setAllAdminDeals([]);
  setDipRemovedProperties([]);
  setSmartParsedData(null);
  setSmartParseSessionId(null);
}

/**
 * For backward compatibility with code that uses window.currentDealId
 */
export function setCurrentDealId(id) {
  window.currentDealId = id;
}

export function getCurrentDealId() {
  return window.currentDealId;
}
