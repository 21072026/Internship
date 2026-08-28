import { ResumeClient } from './ResumeClient';

// Landing spot for a browser that holds a trusted-device cookie but no session
// (#1495). Nothing is decided here — middleware sends people to this route, the
// client below trades the device cookie for a session and continues to `next`.
export default function ResumePage() {
  return <ResumeClient />;
}
