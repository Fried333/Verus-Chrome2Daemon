import React, { useState } from 'react';
import { IconBack } from '../components/Icons';
import { QRCodeSVG } from 'qrcode.react';

interface Props {
  address: string;
  onBack: () => void;
}

export function ReceiveScreen({ address, onBack }: Props) {
  const [copied, setCopied] = useState(false);

  function copyAddress() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="screen">
      <button className="btn-back" onClick={onBack}><IconBack size={16} /> Back</button>
      <h2>Receive</h2>
      <p className="subtitle">Share this address to receive Verus</p>

      <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0' }}>
        <div style={{ background: 'white', padding: 12, borderRadius: 12, border: '1px solid var(--border)' }}>
          <QRCodeSVG value={address} size={180} level="M" />
        </div>
      </div>

      <div style={{
        fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)',
        wordBreak: 'break-all', textAlign: 'center', padding: '0 16px', lineHeight: 1.5,
      }}>
        {address}
      </div>

      <button className="btn btn-primary" onClick={copyAddress}
        style={{ width: '100%', marginTop: 'auto' }}>
        {copied ? 'Copied!' : 'Copy Address'}
      </button>
    </div>
  );
}
