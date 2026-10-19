'use client';

import React, { useState } from 'react';
import ReportForm from '@/components/ReportForm';
import ZoneRiskMap from '@/components/ZoneRiskMap';
import { ShieldAlert, PlusCircle, Map, Radio } from 'lucide-react';

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<'map' | 'report'>('map');

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* Top Navigation */}
      <header className="border-b border-slate-800 bg-slate-900/80 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-600/20 text-emerald-400 ring-1 ring-emerald-500/30">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-2">
                🇳🇬 Nigeria CEWS
                <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-400 ring-1 ring-emerald-500/20">
                  Live
                </span>
              </h1>
              <p className="text-xs text-slate-400">Nationwide Conflict Early Warning System</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setActiveTab('map')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                activeTab === 'map'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <Map className="h-4 w-4" />
              <span>Live Map</span>
            </button>
            <button
              onClick={() => setActiveTab('report')}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                activeTab === 'report'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <PlusCircle className="h-4 w-4" />
              <span>Submit Report</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-7xl">
          {activeTab === 'map' ? (
            <div className="space-y-4">
              <ZoneRiskMap />
            </div>
          ) : (
            <div className="mx-auto max-w-3xl">
              <ReportForm />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
