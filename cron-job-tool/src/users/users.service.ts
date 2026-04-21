import { Inject, Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { EntityManager } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  @Inject(EntityManager)
  entityManager: EntityManager;

  async create(createUserDto: CreateUserDto) {
    console.log('[UsersService.create input]', createUserDto);
    const result = await this.entityManager.save(User, createUserDto);
    console.log('[UsersService.create result]', result);
    return result;
  }

  findAll() {
    return this.entityManager.find(User);
  }

  findOne(id: number) {
    return this.entityManager.findOne(User, { where: { id } });
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return this.entityManager.update(User, id, updateUserDto);
  }

  remove(id: number) {
    return this.entityManager.delete(User, id);
  }
}
