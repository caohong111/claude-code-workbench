import React from 'react';
import { ImagePlus, LoaderCircle, RotateCcw } from 'lucide-react';

const ASSET_SLOTS = [
  ['appIcon', '应用图标'],
  ['claudeAvatar', 'Claude 头像'],
  ['userAvatar', '我的头像'],
];

export default function AppearanceSettings({ appearance = {}, onPick, onReset, busy }) {
  return <div className="appearance-assets">
    {ASSET_SLOTS.map(([slot, label]) => {
      const asset = appearance[slot] || {};
      const pending = busy === slot;
      return <div className="appearance-asset-row" key={slot}>
        <div className="appearance-asset-preview">
          {asset.src && <img src={asset.src} alt={`${label}预览`} />}
        </div>
        <div className="appearance-asset-meta">
          <h4>{label}</h4>
          <span title={asset.fileName || ''}>{asset.fileName || '默认图片'}</span>
        </div>
        <div className="appearance-asset-actions">
          <button type="button" className="button secondary" disabled={Boolean(busy) || !onPick}
            aria-label={`更换${label}`} onClick={() => onPick(slot)}>
            {pending ? <LoaderCircle size={15} className="spin" /> : <ImagePlus size={15} />}更换
          </button>
          <button type="button" className="icon-button" disabled={Boolean(busy) || !asset.custom || !onReset}
            title={`恢复默认${label}`} aria-label={`恢复${label}`} onClick={() => onReset(slot)}>
            <RotateCcw size={16} />
          </button>
        </div>
      </div>;
    })}
  </div>;
}
