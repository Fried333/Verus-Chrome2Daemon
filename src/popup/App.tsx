import React, { useState, useEffect } from 'react';
import { DashboardScreen } from './screens/DashboardScreen';
import { AccountSelectorScreen } from './screens/AccountSelectorScreen';
import { SendScreen } from './screens/SendScreen';
import { ReceiveScreen } from './screens/ReceiveScreen';
import { ApproveScreen } from './screens/ApproveScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SetupScreen } from './screens/SetupScreen';
import { LockScreen } from './screens/LockScreen';
import { LoginApprovalScreen } from './screens/LoginApprovalScreen';
import { SwapScreen } from './screens/SwapScreen';
import { IDsScreen } from './screens/IDsScreen';
import { IDDetailScreen } from './screens/IDDetailScreen';
import { SubscriptionApprovalScreen } from './screens/SubscriptionApprovalScreen';
import { BottomNav, NavTab } from './components/BottomNav';

type Screen = 'loading' | 'lock' | 'setup' | 'main' | 'accounts' | 'send' | 'receive' | 'settings' | 'approve' | 'login-approval' | 'id-detail' | 'subscription';

interface PendingRequest {
  id: string;
  method: string;
  params: any;
  origin: string;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [navTab, setNavTab] = useState<NavTab>('wallet');
  const [walletSubTab, setWalletSubTab] = useState<'currencies' | 'activity'>('currencies');
  const [address, setAddress] = useState<string>('');
  const [accountName, setAccountName] = useState('Account 1');
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [pendingDeeplinks, setPendingDeeplinks] = useState<Array<{ id: string; uri: string; origin: string }>>([]);
  const [hasPassword, setHasPassword] = useState(false);
  const [sendCurrency, setSendCurrency] = useState<string>('VRSC');
  const [swapFromCurrency, setSwapFromCurrency] = useState<string>('VRSC');
  const [selectedId, setSelectedId] = useState<any>(null);
  const [idWalletAddrs, setIdWalletAddrs] = useState<Set<string>>(new Set());
  const [subscriptionData, setSubscriptionData] = useState<any>(null);

  function checkStateAndRoute() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      if (chrome.runtime.lastError) return;
      if (state?.connectedAddress) setAddress(state.connectedAddress);
      setHasPassword(!!state?.hasPassword);

      if (!state?.isUnlocked) {
        setScreen('lock');
        return;
      }

      chrome.runtime.sendMessage({ type: 'GET_PENDING' }, (response) => {
        if (response?.subscriptions?.length > 0) {
          // Show the most recent subscription (last in array)
          setSubscriptionData(response.subscriptions[response.subscriptions.length - 1]);
          setScreen('subscription');
        } else if (response?.deeplinks?.length > 0) {
          setPendingDeeplinks(response.deeplinks);
          setScreen('login-approval');
        } else if (response?.pending?.length > 0) {
          setPending(response.pending);
          setScreen('approve');
        } else if (!state?.hasRpcConfig) {
          setScreen('setup');
        } else {
          testAndGoMain();
        }
      });
    });
  }

  useEffect(() => {
    checkStateAndRoute();

    const listener = (message: any) => {
      if (message.type === 'WALLET_LOCKED') setScreen('lock');
    };
    chrome.runtime.onMessage.addListener(listener);

    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
        if (chrome.runtime.lastError) return;
        if (!state?.isUnlocked && screen !== 'lock' && screen !== 'setup') {
          setScreen('lock');
          return;
        }
        // Check for new pending items while panel is open
        if (state?.isUnlocked && (screen === 'main' || screen === 'subscription')) {
          chrome.runtime.sendMessage({ type: 'GET_PENDING' }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response?.subscriptions?.length > 0) {
              const latest = response.subscriptions[response.subscriptions.length - 1];
              // Only update if provider changed or we're on main screen
              if (screen === 'main' || !subscriptionData || latest.provider !== subscriptionData.provider) {
                setSubscriptionData(latest);
                setScreen('subscription');
              }
            } else if (screen === 'subscription') {
              // Subscription was cleared/timed out — go back to main
              setSubscriptionData(null);
              setScreen('main');
            } else if (response?.deeplinks?.length > 0) {
              setPendingDeeplinks(response.deeplinks);
              setScreen('login-approval');
            }
          });
        }
      });
    }, 2_000);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearInterval(interval);
    };
  }, []);

  function testAndGoMain() {
    chrome.runtime.sendMessage(
      { type: 'POPUP_RPC', method: 'getInfo', params: {} },
      (response) => {
        if (response?.error) {
          setScreen('setup');
        } else {
          if (!address) {
            chrome.runtime.sendMessage(
              { type: 'POPUP_RPC', method: 'getAddress', params: {} },
              (resp) => {
                if (resp?.result && Array.isArray(resp.result) && resp.result[0]) {
                  setAddress(resp.result[0]);
                  chrome.runtime.sendMessage({ type: 'SET_ADDRESS', address: resp.result[0] });
                }
                setScreen('main');
              }
            );
          } else {
            setScreen('main');
          }
        }
      }
    );
  }

  function handleUnlock() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      chrome.runtime.sendMessage({ type: 'GET_PENDING' }, (response) => {
        if (response?.subscriptions?.length > 0) {
          // Show the most recent subscription (last in array)
          setSubscriptionData(response.subscriptions[response.subscriptions.length - 1]);
          setScreen('subscription');
        } else if (response?.deeplinks?.length > 0) {
          setPendingDeeplinks(response.deeplinks);
          setScreen('login-approval');
        } else if (response?.pending?.length > 0) {
          setPending(response.pending);
          setScreen('approve');
        } else if (!state?.hasRpcConfig) {
          setScreen('setup');
        } else {
          testAndGoMain();
        }
      });
    });
  }

  function handleApprove(id: string) {
    chrome.runtime.sendMessage({ type: 'POPUP_APPROVE', id });
    setPending(prev => prev.filter(p => p.id !== id));
    if (pending.length <= 1) setScreen('main');
  }

  function handleReject(id: string) {
    chrome.runtime.sendMessage({ type: 'POPUP_REJECT', id, reason: 'User rejected' });
    setPending(prev => prev.filter(p => p.id !== id));
    if (pending.length <= 1) setScreen('main');
  }

  function handleLock() {
    chrome.runtime.sendMessage({ type: 'LOCK' });
    setScreen('lock');
  }

  function handleAccountSelect(addr: string, name: string) {
    setAddress(addr);
    setAccountName(name);
    chrome.runtime.sendMessage({ type: 'SET_ADDRESS', address: addr });
    setScreen('main');
  }

  // === Render ===

  if (screen === 'loading') {
    return (
      <div className="w-full h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-3 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (screen === 'lock') return <LockScreen isNewUser={!hasPassword} onUnlock={handleUnlock} />;
  if (screen === 'setup') return <SetupScreen onConnected={testAndGoMain} onBack={() => setScreen('main')} />;

  if (screen === 'login-approval' && pendingDeeplinks.length > 0) {
    return <LoginApprovalScreen deeplink={pendingDeeplinks[0]} onDone={() => {
      setPendingDeeplinks(prev => prev.slice(1));
      if (pendingDeeplinks.length <= 1) setScreen('main');
    }} />;
  }

  if (screen === 'approve' && pending.length > 0) {
    return (
      <div className="w-full h-screen bg-gray-50 flex flex-col">
        <ApproveScreen request={pending[0]} remaining={pending.length - 1} onApprove={handleApprove} onReject={handleReject} />
      </div>
    );
  }

  if (screen === 'accounts') {
    return <AccountSelectorScreen currentAddress={address} onBack={() => setScreen('main')} onSelect={handleAccountSelect} />;
  }

  if (screen === 'send') {
    return <SendScreen address={address} defaultCurrency={sendCurrency} onBack={() => setScreen('main')} onSent={() => { setWalletSubTab('activity'); setScreen('main'); }} />;
  }

  if (screen === 'receive') {
    return <ReceiveScreen address={address} onBack={() => setScreen('main')} />;
  }

  if (screen === 'settings') {
    return <SettingsScreen address={address} onBack={() => setScreen('main')} onLock={handleLock} onReconfigure={() => setScreen('setup')} />;
  }

  if (screen === 'subscription' && subscriptionData) {
    return <SubscriptionApprovalScreen
      subscriptionId={subscriptionData.id}
      subscriberId={subscriptionData.subscriberId}
      provider={subscriptionData.provider}
      providerName={subscriptionData.providerName}
      plan={subscriptionData.plan}
      address={address}
      onApprove={() => { setSubscriptionData(null); setScreen('main'); }}
      onReject={() => {
        if (subscriptionData.id) {
          chrome.runtime.sendMessage({ type: 'SUBSCRIPTION_REJECT', id: subscriptionData.id });
        }
        setSubscriptionData(null); setScreen('main');
      }}
    />;
  }

  if (screen === 'id-detail' && selectedId) {
    return <IDDetailScreen
      identity={selectedId}
      canUpdate={idWalletAddrs.has(selectedId.primaryAddress)}
      canRevoke={idWalletAddrs.has(selectedId.revocationAuthority)}
      canRecover={idWalletAddrs.has(selectedId.recoveryAuthority)}
      onBack={() => setScreen('main')}
      onRefresh={() => setScreen('main')}
    />;
  }

  // Main screen with bottom nav
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {navTab === 'wallet' && (
          <DashboardScreen
            address={address}
            accountName={accountName}
            defaultSubTab={walletSubTab}
            onSend={(currency?: string) => { setSendCurrency(currency || 'VRSC'); setScreen('send'); }}
            onSwap={(currency?: string) => { setSwapFromCurrency(currency || 'VRSC'); setNavTab('swap'); }}
            onReceive={() => setScreen('receive')}
            onSettings={() => setScreen('settings')}
            onAccountSelector={() => setScreen('accounts')}
            onAccountNameChange={(name) => setAccountName(name)}
          />
        )}
        {navTab === 'swap' && (
          <SwapScreen address={address} defaultFromCurrency={swapFromCurrency} onComplete={() => { setWalletSubTab('activity'); setNavTab('wallet'); }} />
        )}
        {navTab === 'ids' && (
          <IDsScreen address={address} onSelectId={(id, walletAddrs) => { setSelectedId(id); setIdWalletAddrs(walletAddrs); setScreen('id-detail'); }} />
        )}
      </div>
      <BottomNav active={navTab} onChange={setNavTab} />
    </div>
  );
}
