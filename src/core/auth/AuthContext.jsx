import React, { createContext, useContext, useEffect, useState } from 'react';
import authManager from './AuthManager';
import posthog from '../../services/posthog.js';
import { keyManager } from '../sync/KeyManager';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [authState, setAuthState] = useState({
    isAuthenticated: false,
    user: null,
    isGuest: false,
    isLoading: true
  });

  useEffect(() => {

    // Subscribe to auth state changes
    const unsubscribe = authManager.onAuthStateChange((newState) => {
      setAuthState(prev => {
        const newAuthState = {
          ...prev,
          isAuthenticated: newState.isAuthenticated,
          user: newState.user,
          isGuest: newState.isGuest,
          isLoading: false
        };
        return newAuthState;
      });

      // Identify user in PostHog when authenticated (skip for guests — they get anonymous tracking)
      if (newState.isAuthenticated && newState.user && !newState.isGuest) {
        posthog.identify(newState.user.id, {
          email: newState.user.email
        });
      }
    });

    // Initial state check. A hung or offline auth probe must never leave
    // `isLoading` true forever: AuthGate blocks the entire Preferences window
    // on it, which presents as a blank window that also feels unclosable.
    let cancelled = false;
    const settle = () => {
      if (cancelled) return;
      setAuthState(prev => ({
        ...prev,
        isAuthenticated: authManager.isLoggedIn,
        user: authManager.currentUser,
        isGuest: authManager.isGuest,
        isLoading: false
      }));
    };
    const authTimeoutId = setTimeout(settle, 8000);
    const onSettled = () => {
      clearTimeout(authTimeoutId);
      settle();
    };
    Promise.resolve()
      .then(() => authManager.checkAuthStatus())
      .then(onSettled, onSettled);

    return () => {
      cancelled = true;
      clearTimeout(authTimeoutId);
      unsubscribe();
    };
  }, []);

  // Legacy sign in (Google OAuth)
  const signIn = async () => {
    try {
      await authManager.signIn();
    } catch (error) {
      throw error;
    }
  };

  // Sign in with email and password
  const signInWithEmail = async (email, password) => {
    try {
      return await authManager.signInWithEmail(email, password);
    } catch (error) {
      throw error;
    }
  };

  // Sign up with email and password
  const signUpWithEmail = async (email, password) => {
    try {
      return await authManager.signUpWithEmail(email, password);
    } catch (error) {
      throw error;
    }
  };

  // Sign in with Google
  const signInWithGoogle = async () => {
    try {
      return await authManager.signInWithGoogle();
    } catch (error) {
      throw error;
    }
  };

  // Sign in with Apple
  const signInWithApple = async () => {
    try {
      return await authManager.signInWithApple();
    } catch (error) {
      throw error;
    }
  };

  // Sign out
  const signOut = async () => {
    try {
      // Reset PostHog to anonymous tracking
      posthog.reset();
      // Clear cached encryption key material to prevent leaking to next user
      keyManager.onLogout();
      await authManager.signOut();
    } catch (error) {
      throw error;
    }
  };

  // Delete account
  const deleteAccount = async () => {
    try {
      posthog.reset();
      await authManager.deleteAccount();
    } catch (error) {
      throw error;
    }
  };

  // Get access token
  const getAccessToken = async () => {
    return await authManager.getAccessToken();
  };

  // Authenticated fetch helper
  const authenticatedFetch = async (url, options) => {
    return await authManager.authenticatedFetch(url, options);
  };

  // Continue as guest
  const continueAsGuest = () => {
    authManager.continueAsGuest();
  };

  // Reset password
  const resetPassword = async (email) => {
    try {
      return await authManager.resetPassword(email);
    } catch (error) {
      throw error;
    }
  };

  const value = {
    ...authState,
    signIn,
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    signInWithApple,
    signOut,
    deleteAccount,
    continueAsGuest,
    getAccessToken,
    authenticatedFetch,
    resetPassword
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
