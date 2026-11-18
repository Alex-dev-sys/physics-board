import type { Metadata } from 'next'
import { WorkspaceHome } from './workspace-home'

export const metadata: Metadata = { title: 'Мои доски — Физика' }

export default function Home() {
 return <WorkspaceHome />
}
