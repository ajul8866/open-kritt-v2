import { Router } from 'express';
import { prisma } from '../db.js';
import { boundedEvidence } from '../lib/improvementEvidence.js';

export function createSelfImprovementRouter({ prismaClient = prisma } = {}) {
  const router = Router();
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
