import { Router } from 'express';
import { prisma } from '../db.js';
import { boundedEvidence } from '../lib/improvementEvidence.js';
import { improvementControllerClient } from '../lib/improvementController.js';

export function createSelfImprovementRouter({
  prismaClient = prisma,
  controller = improvementControllerClient(),
} = {}) {
  const router = Router();
  const scanIdPattern = /^[1-9][0-9]*$/;
  const loopIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const proxy = (path) => async (req, res) => {
    if (
      (req.params.id && !scanIdPattern.test(req.params.id)) ||
      (req.params.loopId && !loopIdPattern.test(req.params.loopId))
    ) {
      return res.status(422).json({ error: 'Invalid scan or loop ID.' });
    }
    try {
      const result = await controller(path(req), {
        method: req.method,
        ...(req.method === 'POST' ? { body: req.body } : {}),
      });
      res.set('Cache-Control', 'no-store').status(result.status).json(result.body);
    } catch {
      res
        .status(503)
        .json({ error: 'Self-improvement service is unavailable. Check that the controller service is running.' });
    }
  };
  router.get(
    '/scans/:id/loop',
    proxy((req) => `/scans/${req.params.id}/loop`)
  );
  router.post(
    '/scans/:id/loop',
    proxy((req) => `/scans/${req.params.id}/loop`)
  );
  router.get(
    '/loops/:loopId',
    proxy((req) => `/loops/${req.params.loopId}`)
  );
  router.get(
    '/loops/:loopId/audit',
    proxy((req) => `/loops/${req.params.loopId}/audit`)
  );
  for (const action of ['approval', 'reviews', 'cancel', 'recover']) {
    router.post(
      `/loops/:loopId/${action}`,
      proxy((req) => `/loops/${req.params.loopId}/${action}`)
    );
  }
  router.get('/scans/:id/evidence', async (req, res, next) => {
    try {
      const scanId = BigInt(req.params.id);
      const scan = await prismaClient.scan.findUnique({
        where: { id: scanId },
        select: { id: true, status: true, reasoning: true },
      });
      if (!scan) return res.status(404).json({ error: 'Scan not found.' });
      const [jobs, totalJobs] = await Promise.all([
        prismaClient.stepMetadata.findMany({
          where: { scanId },
          orderBy: { id: 'asc' },
          take: 200,
          select: {
            id: true,
            stepId: true,
            kind: true,
            phase: true,
            status: true,
            error: true,
            stub: true,
            stubExplanation: true,
            checkedOutCommit: true,
            runTimeMs: true,
          },
        }),
        prismaClient.stepMetadata.count({ where: { scanId } }),
      ]);
      res.set('Cache-Control', 'no-store').json({
        scanId: scanId.toString(),
        status: scan.status,
        reasoning: boundedEvidence(scan.reasoning),
        jobs: jobs.map((job) => ({
          ...boundedEvidence({ ...job, runTimeMs: job.runTimeMs?.toString() ?? null }),
        })),
        totalJobs,
        truncated: totalJobs > jobs.length,
        logSource: 'Persisted step/post-processing status, errors and stub explanations; excludes raw harness stdout.',
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export default createSelfImprovementRouter();
