import { Link } from "react-router-dom";

export default function Start() {
  return (
    <div>
      <section className="hero-panel">
        <h1>What are you doing?</h1>
        <p>Start with one choice. The rest of the contract is asked one step at a time.</p>
      </section>
      <div className="choice-grid">
        <Link className="choice-card" to="/new?from=library">
          <strong>Working from the library</strong>
          <span>Use a broker and contractor you have already saved.</span>
        </Link>
        <Link className="choice-card" to="/new?from=new">
          <strong>Sending a new contract</strong>
          <span>Choose the broker, the contract, then who else signs.</span>
        </Link>
      </div>
      <p className="start-links">
        <Link to="/contracts">Contracts already in progress</Link>
        <Link to="/brokers">Brokers</Link>
        <Link to="/contractors">Contractors</Link>
        <Link to="/suppliers">Suppliers</Link>
        <Link to="/compliance">Compliance company</Link>
        <Link to="/templates">Contract templates</Link>
      </p>
    </div>
  );
}
