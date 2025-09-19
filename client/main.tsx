import React from 'react';
import { createRoot } from 'react-dom/client';
import { Reader } from './Reader';

const container = document.getElementById('app')!;
const root = createRoot(container);
root.render(<Reader />);
