import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api.js";
import Dashboard from "./pages/Dashboard.jsx";
import Start from "./pages/Start.jsx";
import PartyRecords from "./pages/PartyRecords.jsx";
import Companies from "./pages/Companies.jsx";
import CompanySetup from "./pages/CompanySetup.jsx";
import Templates from "./pages/Templates.jsx";
import Library from "./pages/Library.jsx";
import CreateEnvelope from "./pages/CreateEnvelope.jsx";
import EnvelopeDetail from "./pages/EnvelopeDetail.jsx";
import SignRoom from "./pages/SignRoom.jsx";
import DiligenceRoom from "./pages/DiligenceRoom.jsx";
import Login from "./pages/Login.jsx";
import ComplianceCompany from "./pages/ComplianceCompany.jsx";

function isPublicRoom(pathname) {
  return pathname.startsWith("/sign/") || pathname.startsWith("/diligence/");
}

export default function App() {
  const location = useLocation();
  const publicRoom = isPublicRoom(location.pathname);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onSignedOut = () => setUser(null);
    window.addEventListener("attest-signed-out", onSignedOut);
    return () => window.removeEventListener("attest-signed-out", onSignedOut);
  }, []);

  useEffect(() => {
    if (publicRoom) {
      setReady(true);
      return undefined;
    }
    let alive = true;
    api
      .me()
      .then((data) => {
        if (alive) setUser(data.user);
      })
      .catch(() => {
        if (alive) setUser(null);
      })
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, [publicRoom]);

  async function signOut() {
    await api.logout();
    setUser(null);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Contract Builder home">
          <img
            className="brand-logo"
            src="/contract-builder-mark.png"
            alt=""
            width={64}
            height={42}
          />
          <span className="brand-copy">
            <span className="brand-mark">Contract Builder</span>
            <span className="brand-sub">Making Your Life Easier</span>
          </span>
        </Link>
        {user && !publicRoom ? (
          <nav className="nav-links">
            <Link to="/contracts">Contracts</Link>
            <button className="btn secondary" type="button" onClick={signOut}>
              Sign out
            </button>
          </nav>
        ) : null}
      </header>
      <main className="main">
        {publicRoom ? (
          <Routes>
            <Route path="/sign/:token" element={<SignRoom />} />
            <Route path="/diligence/:token" element={<DiligenceRoom />} />
          </Routes>
        ) : !ready ? (
          <p className="muted">Loading…</p>
        ) : !user ? (
          <Login onSuccess={setUser} />
        ) : (
          <Routes>
            <Route path="/" element={<Start />} />
            <Route path="/contracts" element={<Dashboard />} />
            <Route path="/companies" element={<Companies />} />
            <Route path="/companies/:id" element={<CompanySetup />} />
            <Route path="/compliance" element={<ComplianceCompany />} />
            <Route path="/brokers" element={<Companies />} />
            <Route path="/brokers/:id" element={<CompanySetup />} />
            <Route path="/entities" element={<Companies />} />
            <Route path="/contractors" element={<PartyRecords kind="contractor" />} />
            <Route path="/contractors/:id" element={<PartyRecords kind="contractor" />} />
            <Route path="/suppliers" element={<PartyRecords kind="supplier" />} />
            <Route path="/suppliers/:id" element={<PartyRecords kind="supplier" />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/library" element={<Library />} />
            <Route path="/new" element={<CreateEnvelope />} />
            <Route path="/envelopes/:id" element={<EnvelopeDetail />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
