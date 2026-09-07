import { InMemoryControlPlaneStore } from '../src/index.js';

export async function createAcmeControlPlane(): Promise<InMemoryControlPlaneStore> {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  return controlPlane;
}
