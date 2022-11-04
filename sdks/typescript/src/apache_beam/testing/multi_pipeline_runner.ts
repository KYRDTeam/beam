/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as runnerApi from "../proto/beam_runner_api";
import * as jobApi from "../proto/beam_job_api";
import { withName } from "../transforms";
import { PipelineOptions } from "../options/pipeline_options";
import { Pipeline } from "../internal/pipeline";
import { PValue, Root } from "../pvalue";
import { PipelineResult, Runner } from "../runners/runner";

class FakePipelineResult extends PipelineResult {
  async waitUntilFinish(duration?: number): Promise<jobApi.JobState_Enum> {
    return jobApi.JobState_Enum.DONE;
  }
}

export class MultiPipelineRunner extends Runner {
  allPipelines?: runnerApi.Pipeline;
  counter: number = 0;

  constructor(
    private underlying: Runner,
    private options: PipelineOptions = {}
  ) {
    super();
  }

  async runAsync(
    pipeline: (root: Root) => PValue<any> | Promise<PValue<any>>,
    options?: PipelineOptions
  ): Promise<PipelineResult> {
    const uniqueName = this.getPrefix();
    const p = new Pipeline(uniqueName);
    await new Root(p).applyAsync(
      withName(uniqueName, async (root) => {
        await pipeline(root);
      })
    );
    return this.runPipeline(p.getProto());
  }

  async runPipeline(
    pipeline: runnerApi.Pipeline,
    options?: PipelineOptions
  ): Promise<PipelineResult> {
    if (options) {
      throw new Error("Per-pipeline options not supported.");
    }
    this.mergePipeline(pipeline);
    return new FakePipelineResult();
  }

  async reallyRunPipelines() {
    if (this.allPipelines === undefined) {
      return new FakePipelineResult();
    }
    console.log(this.allPipelines);
    const pipelineResult = await this.underlying.runPipeline(
      this.allPipelines,
      this.options
    );
    const finalState = await pipelineResult.waitUntilFinish();
    if (finalState != jobApi.JobState_Enum.DONE) {
      // TODO: Grab the last/most severe error message?
      throw new Error(
        "Job finished in state " + jobApi.JobState_Enum[finalState]
      );
    }
    this.allPipelines = undefined;
    return pipelineResult;
  }

  getPrefix(): string {
    try {
      return "namespace_" + this.counter + "_";
    } finally {
      this.counter += 1;
    }
  }

  mergePipeline(pipeline: runnerApi.Pipeline) {
    if (this.allPipelines === undefined) {
      this.allPipelines = runnerApi.Pipeline.create({
        components: runnerApi.Components.create({}),
      });
    }
    function mergeComponents(src, dest) {
      for (const [id, proto] of Object.entries(src)) {
        if (dest[id] === undefined) {
          dest[id] = proto;
        } else if (dest[id] != proto) {
          require('assert').deepEqual(dest[id], proto);
          throw new Error("Expected distinct components: " + id);
        }
      }
    }
    mergeComponents(
      pipeline.components?.transforms,
      this.allPipelines.components?.transforms
    );
    mergeComponents(
      pipeline.components?.pcollections,
      this.allPipelines.components?.pcollections
    );
    mergeComponents(
      pipeline.components?.coders,
      this.allPipelines.components?.coders
    );
    mergeComponents(
      pipeline.components?.windowingStrategies,
      this.allPipelines.components?.windowingStrategies
    );
    mergeComponents(
      pipeline.components?.environments,
      this.allPipelines.components?.environments
    );
    this.allPipelines.requirements =
      [...new Set([...this.allPipelines.rootTransformIds, ...pipeline.requirements])];
    this.allPipelines.rootTransformIds =
      [...this.allPipelines.rootTransformIds, ...pipeline.rootTransformIds];
  }
}
