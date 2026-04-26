import React from 'react';

const bars = [32, 78, 56, 92, 44, 70, 38, 88, 52, 76, 40, 64];

export const VoiceWaveform: React.FC = () => {
  return (
    <div className="flex items-center gap-1 h-6 px-2">
      {bars.map((height, i) => (
        <div 
          key={i}
          className="w-1 bg-primary-400 rounded-full animate-waveform" 
          style={{ 
            height: `${height}%`,
            animationDelay: `${(i + 1) * 0.1}s`
          }}
        />
      ))}
      <style>{`
        @keyframes waveform {
          0%, 100% { height: 20%; }
          50% { height: 100%; }
        }
        .animate-waveform {
          animation: waveform 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
};
